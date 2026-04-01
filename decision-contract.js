(function attachDecisionContractUtils(root, factory) {
  const api = factory();
  root.DecisionContractUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDecisionContractUtils() {
  const CONTRACT_VERSION = 'stage12.v2';
  const SHORTFALL_MARKER = '# SHORTFALL: only 1 company passed Stage 10 gates';
  const CURRENT_RECORD_FORMAT = 'current_17_role';
  const CURRENT_COMPATIBLE_RECORD_FORMATS = new Set(['current_17_role', 'current_16_role']);
  const LEGACY_RECORD_FORMATS = new Set([
    'current_12',
    'current_13_role',
    'transitional_13',
    'transitional_16'
  ]);
  const CURRENT_FIELD_10_KEYS = ['voi', 'fals', 'primaryRisk', 'composite', 'entryScore', 'sizing'];
  const LEGACY_FIELD_10_KEYS = ['voi', 'fals', 'primaryRisk', 'composite', 'sizing'];
  const FIELD_10_LABEL_REGEX = /\b(VOI|Fals(?:ifiers)?|Primary risk|Composite|EntryScore|Sizing)\s*:/gi;
  const KPI_SCORECARD_KEYS = ['FQ', 'TE', 'CM', 'VS', 'TQ', 'PP', 'CP', 'CD', 'NO', 'MR'];
  const OPPORTUNITY_KEYS = [
    'value_chain_position',
    'price_dislocation_reason',
    'rerating_catalyst_type',
    'time_horizon_type',
    'entry_condition_type'
  ];
  const CHARACTER_KEYS = [
    'quality_state',
    'safety_state',
    'thesis_stock_relationship',
    'proof_class',
    'confidence_in_thesis',
    'primary_kill_risk'
  ];

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function uniqueStrings(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim())));
  }

  function normalizeStructuredNamedSection(section, keys) {
    const source = section && typeof section === 'object' ? section : {};
    const normalized = {};
    keys.forEach((key) => {
      normalized[key] = normalizeText(source[key]);
    });
    return normalized;
  }

  function parseDecisionRecordParts(rawLine) {
    const line = normalizeText(rawLine);
    if (!line || !line.includes(';')) return null;
    const parts = line
      .split(';')
      .map((item) => item.trim())
      .filter((item, index, all) => !(index === all.length - 1 && item === ''));
    if (parts.length !== 12 && parts.length !== 13 && parts.length !== 16 && parts.length !== 17) return null;
    return parts;
  }

  function parseKpiScorecard(rawValue) {
    const source = normalizeText(rawValue);
    const meta = {
      raw: source,
      values: {},
      orderedKeys: [],
      issueCodes: [],
      isComplete: false
    };
    if (!source) {
      meta.issueCodes.push('kpi_empty');
      return meta;
    }

    const segments = source.split(',').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length !== KPI_SCORECARD_KEYS.length) {
      meta.issueCodes.push('kpi_wrong_segment_count');
      return meta;
    }

    for (const segment of segments) {
      const match = segment.match(/^([A-Za-z]{2})\s*:\s*(\d{1,2})$/);
      if (!match) {
        meta.issueCodes.push('kpi_invalid_segment_shape');
        return meta;
      }
      const key = match[1].toUpperCase();
      const value = Number.parseInt(match[2], 10);
      meta.orderedKeys.push(key);
      meta.values[key] = value;
    }

    const orderMatches = KPI_SCORECARD_KEYS.every((key, index) => meta.orderedKeys[index] === key);
    const valuesInRange = KPI_SCORECARD_KEYS.every((key) => Number.isInteger(meta.values[key]) && meta.values[key] >= 1 && meta.values[key] <= 10);
    if (!orderMatches) meta.issueCodes.push('kpi_invalid_order');
    if (!valuesInRange) meta.issueCodes.push('kpi_invalid_value_range');
    if (meta.issueCodes.length === 0) {
      meta.isComplete = true;
    }
    return meta;
  }

  function mapField10Label(rawLabel) {
    const normalized = normalizeText(rawLabel).toLowerCase();
    if (normalized === 'voi') return 'voi';
    if (normalized === 'fals' || normalized === 'falsifiers') return 'fals';
    if (normalized === 'primary risk') return 'primaryRisk';
    if (normalized === 'composite') return 'composite';
    if (normalized === 'entryscore') return 'entryScore';
    if (normalized === 'sizing') return 'sizing';
    return '';
  }

  function parseNumberFromText(value) {
    const normalized = normalizeText(value).replace(',', '.');
    if (!normalized) return Number.NaN;
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) return Number.NaN;
    return Number.parseFloat(match[0]);
  }

  function parsePercentFromText(value) {
    const normalized = normalizeText(value).replace(',', '.');
    if (!normalized) return Number.NaN;
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (!match) return Number.NaN;
    return Number.parseFloat(match[1]);
  }

  function parseField10Meta(rawValue) {
    const source = normalizeText(rawValue);
    const meta = {
      raw: source,
      voi: '',
      fals: '',
      primaryRisk: '',
      composite: '',
      entryScore: '',
      sizing: '',
      compositeValue: Number.NaN,
      entryScoreValue: Number.NaN,
      sizingPercent: Number.NaN,
      orderedLabels: [],
      issueCodes: [],
      isComplete: false,
      schemaVersion: ''
    };
    if (!source) {
      meta.issueCodes.push('field10_empty');
      return meta;
    }

    const matches = [];
    FIELD_10_LABEL_REGEX.lastIndex = 0;
    let match = null;
    while ((match = FIELD_10_LABEL_REGEX.exec(source)) !== null) {
      const key = mapField10Label(match[1]);
      if (!key) continue;
      matches.push({
        key,
        index: match.index,
        valueStart: FIELD_10_LABEL_REGEX.lastIndex
      });
    }

    if (matches.length === 0) {
      meta.issueCodes.push('field10_no_prefixed_segments');
      return meta;
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const segment = source.slice(current.valueStart, next ? next.index : source.length)
        .replace(/^,\s*/, '')
        .replace(/,\s*$/, '')
        .trim();
      meta[current.key] = segment;
      meta.orderedLabels.push(current.key);
    }

    const missingCurrentKeys = CURRENT_FIELD_10_KEYS.filter((key) => !normalizeText(meta[key]));
    const currentOrderMatches = CURRENT_FIELD_10_KEYS.every((key, index) => meta.orderedLabels[index] === key);
    const missingLegacyKeys = LEGACY_FIELD_10_KEYS.filter((key) => !normalizeText(meta[key]));
    const legacyOrderMatches = LEGACY_FIELD_10_KEYS.every((key, index) => meta.orderedLabels[index] === key);

    meta.compositeValue = parseNumberFromText(meta.composite);
    meta.entryScoreValue = parseNumberFromText(meta.entryScore);
    meta.sizingPercent = parsePercentFromText(meta.sizing);
    if (missingCurrentKeys.length === 0 && currentOrderMatches) {
      meta.isComplete = true;
      meta.schemaVersion = 'field10_v2_entryscore';
      return meta;
    }

    if (missingLegacyKeys.length === 0 && legacyOrderMatches && !normalizeText(meta.entryScore)) {
      meta.isComplete = true;
      meta.schemaVersion = 'field10_v1_legacy';
      return meta;
    }

    meta.issueCodes.push('field10_missing_segments');
    meta.issueCodes.push('field10_invalid_order');
    return meta;
  }

  function safeParseJsonObject(rawText) {
    const text = normalizeText(rawText);
    if (!text) return null;

    const candidates = [text];
    const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch?.[1]) {
      candidates.unshift(fencedMatch[1].trim());
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
    }

    for (const candidate of candidates) {
      if (!normalizeText(candidate).startsWith('{')) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (error) {
        continue;
      }
    }
    return null;
  }

  function serializeStructuredKpiScorecard(kpi) {
    if (!kpi || typeof kpi !== 'object') return '';
    const schemaId = normalizeText(kpi.schema_id || kpi.schemaId).toLowerCase();
    const items = Array.isArray(kpi.items) ? kpi.items : [];
    if (schemaId !== 'core10' || items.length === 0) return '';

    const ordered = {};
    items.forEach((item) => {
      const key = normalizeText(item?.key).toUpperCase();
      const value = Number.isFinite(item?.value) ? item.value : Number.parseInt(item?.value, 10);
      if (key && Number.isInteger(value)) {
        ordered[key] = value;
      }
    });

    if (!KPI_SCORECARD_KEYS.every((key) => Number.isInteger(ordered[key]) && ordered[key] >= 1 && ordered[key] <= 10)) {
      return '';
    }
    return KPI_SCORECARD_KEYS.map((key) => `${key}:${ordered[key]}`).join(',');
  }

  function normalizeStructuredPayloadRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const fields = record.fields && typeof record.fields === 'object' ? record.fields : {};
    const taxonomy = record.taxonomy && typeof record.taxonomy === 'object' ? record.taxonomy : {};
    const opportunity = record.opportunity && typeof record.opportunity === 'object' ? record.opportunity : {};
    const character = record.character && typeof record.character === 'object' ? record.character : {};
    const kpi = record.kpi && typeof record.kpi === 'object' ? record.kpi : {};
    const extras = record.extras && typeof record.extras === 'object' ? record.extras : {};
    const decisionRole = normalizeText(record.decision_role || fields.decision_role).toUpperCase();
    if (decisionRole !== 'PRIMARY' && decisionRole !== 'SECONDARY') return null;

    return {
      decision_role: decisionRole,
      fields: {
        ...fields,
        decision_role: decisionRole
      },
      taxonomy,
      opportunity: normalizeStructuredNamedSection(opportunity, OPPORTUNITY_KEYS),
      character: normalizeStructuredNamedSection(character, CHARACTER_KEYS),
      kpi,
      extras
    };
  }

  function extractStructuredDecisionPayload(rawText) {
    const parsed = safeParseJsonObject(rawText);
    if (!parsed) return null;
    if (normalizeText(parsed.schema).toLowerCase() !== 'economist.response.v2') return null;

    const records = (Array.isArray(parsed.records) ? parsed.records : [])
      .map((record) => normalizeStructuredPayloadRecord(record))
      .filter(Boolean);
    if (records.length === 0) return null;

    return {
      schema: 'economist.response.v2',
      records
    };
  }

  function mapStructuredRecordToDecisionRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const fields = record.fields && typeof record.fields === 'object' ? record.fields : {};
    const taxonomy = record.taxonomy && typeof record.taxonomy === 'object' ? record.taxonomy : {};
    const opportunity = record.opportunity && typeof record.opportunity === 'object' ? record.opportunity : {};
    const character = record.character && typeof record.character === 'object' ? record.character : {};
    const kpi = record.kpi && typeof record.kpi === 'object' ? record.kpi : {};
    const kpiScorecard = serializeStructuredKpiScorecard(kpi);

    return {
      canonicalLine: '',
      recordFormat: 'structured_v2_json',
      rawFieldCount: 0,
      decisionDate: normalizeText(fields.data_decyzji),
      decisionStatus: normalizeText(fields.status_decyzji),
      decisionRole: normalizeText(record.decision_role || fields.decision_role).toUpperCase(),
      company: normalizeText(fields.spolka),
      sourceMaterial: normalizeText(fields.material_zrodlowy_podcast || fields.zrodlo_tezy),
      thesis: normalizeText(fields.teza_inwestycyjna),
      asymmetry: '',
      bear: normalizeText(fields.bear_scenario_total),
      base: normalizeText(fields.base_scenario_total),
      bull: normalizeText(fields.bull_scenario_total),
      voi: normalizeText(fields.voi_falsy_kluczowe_ryzyka),
      sector: normalizeText(taxonomy.sector || fields.sektor),
      companyFamily: normalizeText(taxonomy.company_family || fields.rodzina_spolki || taxonomy.sector || fields.sektor),
      companyType: normalizeText(taxonomy.company_type || fields.typ_spolki),
      revenueModel: normalizeText(taxonomy.revenue_model || fields.model_przychodu),
      region: normalizeText(taxonomy.region || fields.region),
      currency: normalizeText(taxonomy.currency || fields.waluta),
      kpiScorecard,
      field10Meta: parseField10Meta(fields.voi_falsy_kluczowe_ryzyka),
      kpiMeta: kpiScorecard
        ? parseKpiScorecard(kpiScorecard)
        : { isComplete: true, issueCodes: [], values: {}, orderedKeys: [] },
      fields,
      taxonomy,
      opportunity: normalizeStructuredNamedSection(opportunity, OPPORTUNITY_KEYS),
      character: normalizeStructuredNamedSection(character, CHARACTER_KEYS),
      kpi,
      extras: record.extras && typeof record.extras === 'object' ? record.extras : {}
    };
  }

  function parseDecisionRecordLine(rawLine) {
    const line = normalizeText(rawLine);
    const parts = parseDecisionRecordParts(line);
    if (!parts) return null;

    if (parts.length === 17) {
      const decisionRole = normalizeText(parts[2]).toUpperCase();
      const hasExplicitRole = decisionRole === 'PRIMARY' || decisionRole === 'SECONDARY';
      const field10Meta = parseField10Meta(parts[9]);
      const kpiMeta = parseKpiScorecard(parts[16]);
      if (hasExplicitRole) {
        return {
          canonicalLine: parts.join('; '),
          recordFormat: CURRENT_RECORD_FORMAT,
          rawFieldCount: 17,
          decisionDate: parts[0],
          decisionStatus: parts[1],
          decisionRole,
          company: parts[3],
          sourceMaterial: parts[4],
          thesis: parts[5],
          asymmetry: '',
          bear: parts[6],
          base: parts[7],
          bull: parts[8],
          voi: parts[9],
          sector: parts[10],
          companyFamily: parts[11],
          companyType: parts[12],
          revenueModel: parts[13],
          region: parts[14],
          currency: parts[15],
          kpiScorecard: parts[16],
          field10Meta,
          kpiMeta
        };
      }
      return null;
    }

    if (parts.length === 16) {
      const decisionRole = normalizeText(parts[2]).toUpperCase();
      const hasExplicitRole = decisionRole === 'PRIMARY' || decisionRole === 'SECONDARY';
      const field10Meta = parseField10Meta(parts[9]);
      if (hasExplicitRole) {
        return {
          canonicalLine: parts.join('; '),
          recordFormat: 'current_16_role',
          rawFieldCount: 16,
          decisionDate: parts[0],
          decisionStatus: parts[1],
          decisionRole,
          company: parts[3],
          sourceMaterial: parts[4],
          thesis: parts[5],
          asymmetry: '',
          bear: parts[6],
          base: parts[7],
          bull: parts[8],
          voi: parts[9],
          sector: parts[10],
          companyFamily: parts[11],
          companyType: parts[12],
          revenueModel: parts[13],
          region: parts[14],
          currency: parts[15],
          kpiScorecard: '',
          field10Meta,
          kpiMeta: parseKpiScorecard('')
        };
      }
      return {
        canonicalLine: parts.join('; '),
        recordFormat: 'transitional_16',
        rawFieldCount: 16,
        decisionDate: parts[0],
        decisionStatus: parts[1],
        decisionRole: '',
        company: parts[2],
        sourceMaterial: parts[3],
        thesis: parts[4],
        asymmetry: parts[5],
        bear: parts[6],
        base: parts[7],
        bull: parts[8],
        voi: parts[9],
        sector: parts[10],
        companyFamily: parts[11],
        companyType: parts[12],
        revenueModel: parts[13],
        region: parts[14],
        currency: parts[15],
        kpiScorecard: '',
        field10Meta,
        kpiMeta: parseKpiScorecard('')
      };
    }

    if (parts.length === 13) {
      const decisionRole = normalizeText(parts[2]).toUpperCase();
      const hasExplicitRole = decisionRole === 'PRIMARY' || decisionRole === 'SECONDARY';
      const field10Meta = parseField10Meta(parts[9]);
      if (hasExplicitRole) {
        return {
          canonicalLine: parts.join('; '),
          recordFormat: 'current_13_role',
          rawFieldCount: 13,
          decisionDate: parts[0],
          decisionStatus: parts[1],
          decisionRole,
          company: parts[3],
          sourceMaterial: parts[4],
          thesis: parts[5],
          asymmetry: '',
          bear: parts[6],
          base: parts[7],
          bull: parts[8],
          voi: parts[9],
          sector: parts[10],
          companyFamily: parts[10],
          companyType: '',
          revenueModel: '',
          region: parts[11],
          currency: parts[12],
          kpiScorecard: '',
          field10Meta,
          kpiMeta: parseKpiScorecard('')
        };
      }
      return {
        canonicalLine: parts.join('; '),
        recordFormat: 'transitional_13',
        rawFieldCount: 13,
        decisionDate: parts[0],
        decisionStatus: parts[1],
        decisionRole: '',
        company: parts[2],
        sourceMaterial: parts[3],
        thesis: parts[4],
        asymmetry: parts[5],
        bear: parts[6],
        base: parts[7],
        bull: parts[8],
        voi: parts[9],
        sector: parts[10],
        companyFamily: parts[10],
        companyType: '',
        revenueModel: '',
        region: parts[11],
        currency: parts[12],
        kpiScorecard: '',
        field10Meta,
        kpiMeta: parseKpiScorecard('')
      };
    }

    const thesisText = typeof parts[4] === 'string' ? parts[4] : '';
    const asymmetryMatch = thesisText.match(/(?:Asymetria|Asymmetry)\s*:\s*[^,;]+/i);
    return {
      canonicalLine: parts.join('; '),
      recordFormat: 'current_12',
      rawFieldCount: 12,
      decisionDate: parts[0],
      decisionStatus: parts[1],
      decisionRole: '',
      company: parts[2],
      sourceMaterial: parts[3],
      thesis: parts[4],
      asymmetry: asymmetryMatch ? asymmetryMatch[0].trim() : '',
      bear: parts[5],
      base: parts[6],
      bull: parts[7],
      voi: parts[8],
      sector: parts[9],
      companyFamily: parts[9],
      companyType: '',
      revenueModel: '',
      region: parts[10],
      currency: parts[11],
      kpiScorecard: '',
      field10Meta: parseField10Meta(parts[8]),
      kpiMeta: parseKpiScorecard('')
    };
  }

  function splitDecisionLines(text) {
    return normalizeText(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function isShortfallMarkerLine(line) {
    return /^#\s*SHORTFALL\s*:/i.test(normalizeText(line));
  }

  function extractDecisionRecordsFromText(rawText) {
    const structuredPayload = extractStructuredDecisionPayload(rawText);
    if (structuredPayload) {
      return structuredPayload.records
        .map((record) => mapStructuredRecordToDecisionRecord(record))
        .filter(Boolean);
    }

    const text = normalizeText(rawText);
    if (!text) return [];

    const lines = splitDecisionLines(text);
    const parsedRecords = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (isShortfallMarkerLine(lines[index])) continue;
      const parsed = parseDecisionRecordLine(lines[index]);
      if (parsed) parsedRecords.push(parsed);
    }
    if (parsedRecords.length > 0) return parsedRecords;

    if (!text.includes(';')) return [];
    const flattened = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    const parsedWhole = parseDecisionRecordLine(flattened);
    return parsedWhole ? [parsedWhole] : [];
  }

  function extractDecisionRecordFromText(rawText) {
    const records = extractDecisionRecordsFromText(rawText);
    if (records.length === 0) return null;
    return records.find((record) => record.decisionRole === 'PRIMARY')
      || records[records.length - 1];
  }

  function buildCanonicalDecisionText(records, options = {}) {
    const safeRecords = Array.isArray(records) ? records.filter((record) => record && typeof record === 'object') : [];
    if (safeRecords.length === 0) return '';
    const lines = safeRecords
      .map((record) => normalizeText(record.canonicalLine))
      .filter(Boolean);
    if (options.shortfall === true) {
      lines.push(SHORTFALL_MARKER);
    }
    return lines.join('\n').trim();
  }

  function buildRecordSignalSummary(record) {
    if (!record || typeof record !== 'object') return null;
    const field10Meta = record.field10Meta && typeof record.field10Meta === 'object'
      ? record.field10Meta
      : parseField10Meta(record.voi || '');
    return {
      role: normalizeText(record.decisionRole),
      format: normalizeText(record.recordFormat),
      decisionDate: normalizeText(record.decisionDate),
      decisionStatus: normalizeText(record.decisionStatus),
      company: normalizeText(record.company),
      composite: normalizeText(field10Meta.composite),
      compositeValue: Number.isFinite(field10Meta.compositeValue) ? field10Meta.compositeValue : parseNumberFromText(field10Meta.composite),
      entryScore: normalizeText(field10Meta.entryScore),
      entryScoreValue: Number.isFinite(field10Meta.entryScoreValue) ? field10Meta.entryScoreValue : parseNumberFromText(field10Meta.entryScore),
      sizing: normalizeText(field10Meta.sizing),
      sizingPercent: Number.isFinite(field10Meta.sizingPercent) ? field10Meta.sizingPercent : parsePercentFromText(field10Meta.sizing),
      voi: normalizeText(field10Meta.voi),
      fals: normalizeText(field10Meta.fals),
      primaryRisk: normalizeText(field10Meta.primaryRisk),
      sector: normalizeText(record.sector),
      companyFamily: normalizeText(record.companyFamily || record.sector),
      companyType: normalizeText(record.companyType),
      revenueModel: normalizeText(record.revenueModel),
      region: normalizeText(record.region),
      currency: normalizeText(record.currency),
      kpiScorecard: normalizeText(record.kpiScorecard)
    };
  }

  function normalizeDecisionContractRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const field10Meta = record.field10Meta && typeof record.field10Meta === 'object'
      ? record.field10Meta
      : parseField10Meta(record.voi || '');
    const composite = normalizeText(record.composite || field10Meta.composite);
    const entryScore = normalizeText(record.entryScore || field10Meta.entryScore);
    const sizing = normalizeText(record.sizing || field10Meta.sizing);
    const normalized = {
      role: normalizeText(record.role || record.decisionRole).toUpperCase(),
      format: normalizeText(record.format || record.recordFormat),
      decisionDate: normalizeText(record.decisionDate),
      decisionStatus: normalizeText(record.decisionStatus),
      company: normalizeText(record.company),
      composite,
      compositeValue: Number.isFinite(record.compositeValue)
        ? record.compositeValue
        : (Number.isFinite(field10Meta.compositeValue) ? field10Meta.compositeValue : parseNumberFromText(composite)),
      entryScore,
      entryScoreValue: Number.isFinite(record.entryScoreValue)
        ? record.entryScoreValue
        : (Number.isFinite(field10Meta.entryScoreValue) ? field10Meta.entryScoreValue : parseNumberFromText(entryScore)),
      sizing,
      sizingPercent: Number.isFinite(record.sizingPercent)
        ? record.sizingPercent
        : (Number.isFinite(field10Meta.sizingPercent) ? field10Meta.sizingPercent : parsePercentFromText(sizing)),
      voi: normalizeText(record.voi || field10Meta.voi),
      fals: normalizeText(record.fals || field10Meta.fals),
      primaryRisk: normalizeText(record.primaryRisk || field10Meta.primaryRisk),
      sector: normalizeText(record.sector),
      companyFamily: normalizeText(record.companyFamily || record.sector),
      companyType: normalizeText(record.companyType),
      revenueModel: normalizeText(record.revenueModel),
      region: normalizeText(record.region),
      currency: normalizeText(record.currency),
      kpiScorecard: normalizeText(record.kpiScorecard)
    };
    return normalized;
  }

  function normalizeDecisionContractSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const records = Array.isArray(summary.records)
      ? summary.records.map((record) => normalizeDecisionContractRecord(record)).filter(Boolean)
      : [];
    return {
      version: normalizeText(summary.version, CONTRACT_VERSION),
      status: normalizeText(summary.status, 'invalid'),
      recordCount: Number.isInteger(summary.recordCount) ? summary.recordCount : records.length,
      recordFormats: uniqueStrings(
        (Array.isArray(summary.recordFormats) ? summary.recordFormats : [])
          .concat(records.map((record) => record.format))
      ),
      issueCodes: uniqueStrings(Array.isArray(summary.issueCodes) ? summary.issueCodes : []),
      records
    };
  }

  function getDecisionContractPrimaryRecord(summary) {
    const normalized = normalizeDecisionContractSummary(summary);
    if (!normalized || normalized.records.length === 0) return null;
    return normalized.records.find((record) => record.role === 'PRIMARY')
      || normalized.records[0]
      || null;
  }

  function getDecisionContractSecondaryRecord(summary) {
    const normalized = normalizeDecisionContractSummary(summary);
    if (!normalized || normalized.records.length === 0) return null;
    return normalized.records.find((record) => record.role === 'SECONDARY')
      || null;
  }

  function buildDecisionContractSnapshot(summary) {
    const normalized = normalizeDecisionContractSummary(summary);
    if (!normalized) {
      return {
        status: 'invalid',
        issueCodes: [],
        recordCount: 0,
        recordFormats: [],
        records: [],
        primaryRecord: null,
        secondaryRecord: null,
        company: '',
        hasDecisionRecord: false,
        hasRenderableCompany: false,
        secondaryPresent: false
      };
    }
    const primaryRecord = getDecisionContractPrimaryRecord(normalized);
    const secondaryRecord = getDecisionContractSecondaryRecord(normalized);
    const company = normalizeText(primaryRecord?.company || secondaryRecord?.company || normalized.records[0]?.company);
    return {
      status: normalized.status,
      issueCodes: normalized.issueCodes.slice(),
      recordCount: normalized.recordCount,
      recordFormats: normalized.recordFormats.slice(),
      records: normalized.records.slice(),
      primaryRecord,
      secondaryRecord,
      company,
      hasDecisionRecord: normalized.records.length > 0,
      hasRenderableCompany: Boolean(company),
      secondaryPresent: !!secondaryRecord
    };
  }

  function validateDecisionContractText(rawText) {
    const text = normalizeText(rawText);
    const structuredPayload = extractStructuredDecisionPayload(text);
    if (structuredPayload) {
      const records = structuredPayload.records
        .map((record) => mapStructuredRecordToDecisionRecord(record))
        .filter(Boolean);

      const issueCodes = [];
      let status = 'invalid';

      if (records.length === 2) {
        if (records[0].decisionRole !== 'PRIMARY' || records[1].decisionRole !== 'SECONDARY') {
          issueCodes.push('invalid_role_order');
        }
        if (records.some((record) => !record.field10Meta || record.field10Meta.isComplete !== true)) {
          issueCodes.push('field10_invalid');
        }
        if (issueCodes.length === 0) {
          status = 'current';
        }
      } else if (records.length === 1) {
        if (records[0].decisionRole !== 'PRIMARY') {
          issueCodes.push('shortfall_requires_primary_role');
        }
        if (records.some((record) => !record.field10Meta || record.field10Meta.isComplete !== true)) {
          issueCodes.push('field10_invalid');
        }
        if (issueCodes.length === 0) {
          status = 'shortfall';
        }
      } else {
        issueCodes.push('no_decision_records');
      }

      const recordFormats = uniqueStrings(records.map((record) => record.recordFormat));
      const selectedRecord = records.find((record) => record.decisionRole === 'PRIMARY')
        || records[records.length - 1]
        || null;
      const decisionContract = {
        version: CONTRACT_VERSION,
        status,
        recordCount: records.length,
        recordFormats,
        issueCodes: uniqueStrings(issueCodes),
        records: records.map((record) => buildRecordSignalSummary(record)).filter(Boolean)
      };

      return {
        text,
        lines: [text],
        nonShortfallLines: [text],
        shortfallLines: [],
        records,
        structuredPayload,
        selectedRecord,
        primaryRecord: records.find((record) => record.decisionRole === 'PRIMARY') || null,
        recordCount: records.length,
        recordFormats,
        issueCodes: uniqueStrings(issueCodes),
        status,
        canonicalText: text,
        shortfallDetected: status === 'shortfall',
        usedFlattenedText: false,
        currentContractPassed: status === 'current' || status === 'shortfall',
        decisionContract
      };
    }

    const lines = splitDecisionLines(text);
    const shortfallLines = lines.filter((line) => isShortfallMarkerLine(line));
    const nonShortfallLines = lines.filter((line) => !isShortfallMarkerLine(line));
    const recordsFromLines = [];
    let unparsedRecordLineCount = 0;

    nonShortfallLines.forEach((line) => {
      const parsed = parseDecisionRecordLine(line);
      if (parsed) {
        recordsFromLines.push(parsed);
      } else if (line.includes(';')) {
        unparsedRecordLineCount += 1;
      }
    });

    let records = recordsFromLines.slice();
    let usedFlattenedText = false;
    if (records.length === 0 && text.includes(';')) {
      const flattened = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      const parsedWhole = parseDecisionRecordLine(flattened);
      if (parsedWhole) {
        records = [parsedWhole];
        usedFlattenedText = true;
      }
    }

    const issueCodes = [];
    if (!text) {
      issueCodes.push('empty_text');
    }
    if (records.length === 0) {
      issueCodes.push('no_decision_records');
    }
    if (unparsedRecordLineCount > 0) {
      issueCodes.push('unparsed_record_lines');
    }
    if (shortfallLines.length > 1) {
      issueCodes.push('multiple_shortfall_markers');
    }

    const recordFormats = uniqueStrings(records.map((record) => record.recordFormat));
    const currentCompatibleOnly = records.length > 0 && records.every((record) => CURRENT_COMPATIBLE_RECORD_FORMATS.has(record.recordFormat));
    const legacyOnly = records.length > 0 && records.every((record) => LEGACY_RECORD_FORMATS.has(record.recordFormat));

    let status = 'invalid';
    if (currentCompatibleOnly) {
      if (shortfallLines.length === 0) {
        if (records.length !== 2 || nonShortfallLines.length !== 2) {
          issueCodes.push('expected_two_record_lines');
        } else if (records[0].decisionRole !== 'PRIMARY' || records[1].decisionRole !== 'SECONDARY') {
          issueCodes.push('invalid_role_order');
        }
        if (records.some((record) => !record.field10Meta || record.field10Meta.isComplete !== true)) {
          issueCodes.push('field10_invalid');
        }
        if (records.some((record) => record.recordFormat === CURRENT_RECORD_FORMAT && (!record.kpiMeta || record.kpiMeta.isComplete !== true))) {
          issueCodes.push('kpi_scorecard_invalid');
        }
        if (issueCodes.length === 0) {
          status = 'current';
        }
      } else {
        if (records.length !== 1 || nonShortfallLines.length !== 1) {
          issueCodes.push('shortfall_expected_single_record');
        }
        if (records[0]?.decisionRole !== 'PRIMARY') {
          issueCodes.push('shortfall_requires_primary_role');
        }
        if (lines.length !== 2 || shortfallLines.length !== 1) {
          issueCodes.push('invalid_shortfall_shape');
        }
        if (records.some((record) => !record.field10Meta || record.field10Meta.isComplete !== true)) {
          issueCodes.push('field10_invalid');
        }
        if (records.some((record) => record.recordFormat === CURRENT_RECORD_FORMAT && (!record.kpiMeta || record.kpiMeta.isComplete !== true))) {
          issueCodes.push('kpi_scorecard_invalid');
        }
        if (issueCodes.length === 0) {
          status = 'shortfall';
        }
      }
    } else if (legacyOnly) {
      status = 'legacy';
      issueCodes.push('legacy_format_detected');
    } else if (records.length > 0) {
      issueCodes.push('mixed_record_formats');
    }

    const selectedRecord = records.find((record) => record.decisionRole === 'PRIMARY')
      || records[records.length - 1]
      || null;
    const decisionContract = {
      version: CONTRACT_VERSION,
      status,
      recordCount: records.length,
      recordFormats,
      issueCodes: uniqueStrings(issueCodes),
      records: records.map((record) => buildRecordSignalSummary(record)).filter(Boolean)
    };

    return {
      text,
      lines,
      nonShortfallLines,
      shortfallLines,
      records,
      selectedRecord,
      primaryRecord: records.find((record) => record.decisionRole === 'PRIMARY') || null,
      recordCount: records.length,
      recordFormats,
      issueCodes: uniqueStrings(issueCodes),
      status,
      canonicalText: buildCanonicalDecisionText(records, { shortfall: status === 'shortfall' }),
      shortfallDetected: status === 'shortfall',
      usedFlattenedText,
      currentContractPassed: status === 'current' || status === 'shortfall',
      decisionContract
    };
  }

  function buildDecisionContractSummary(rawText) {
    return validateDecisionContractText(rawText).decisionContract;
  }

  function getDecisionContractStatusScore(status) {
    if (status === 'current') return 4;
    if (status === 'shortfall') return 3;
    if (status === 'legacy') return 2;
    return 1;
  }

  function formatDecisionRecordTable(rawText) {
    const validation = validateDecisionContractText(rawText);
    const record = validation.primaryRecord || validation.selectedRecord;
    if (!record) return null;
    const parts = parseDecisionRecordParts(record.canonicalLine);
    if (!parts) return null;

    const labels12 = [
      'Data decyzji',
      'Status decyzji',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor',
      'Region',
      'Waluta'
    ];
    const labels17Role = [
      'Data decyzji',
      'Status decyzji',
      'Rola',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor (alias)',
      'Rodzina spolki',
      'Typ spolki',
      'Model przychodu',
      'Region',
      'Waluta',
      'KPI Scorecard'
    ];
    const labels16Role = [
      'Data decyzji',
      'Status decyzji',
      'Rola',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor (alias)',
      'Rodzina spolki',
      'Typ spolki',
      'Model przychodu',
      'Region',
      'Waluta'
    ];
    const labels16Legacy = [
      'Data decyzji',
      'Status decyzji',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Asymetria/Divergence',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor (alias)',
      'Rodzina spolki',
      'Typ spolki',
      'Model przychodu',
      'Region',
      'Waluta'
    ];
    const labels13Role = [
      'Data decyzji',
      'Status decyzji',
      'Rola',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor',
      'Region',
      'Waluta'
    ];
    const labels13Legacy = [
      'Data decyzji',
      'Status decyzji',
      'Spolka',
      'Material zrodlowy',
      'Teza inwestycyjna',
      'Asymetria/Divergence',
      'Bear scenario (TOTAL)',
      'Base scenario (TOTAL)',
      'Bull scenario (TOTAL)',
      'VOI/Falsifiers/Primary risk + Composite + EntryScore + Sizing',
      'Sektor',
      'Region',
      'Waluta'
    ];

    let labels = labels12;
    if (parts.length === 17) {
      labels = labels17Role;
    } else if (parts.length === 16) {
      labels = record.recordFormat === 'transitional_16' ? labels16Legacy : labels16Role;
    } else if (parts.length === 13) {
      labels = record.recordFormat === 'current_13_role' ? labels13Role : labels13Legacy;
    }

    return labels
      .map((label, index) => `${index + 1} - ${label} - ${parts[index] || ''}`)
      .join('\n');
  }

  return {
    CONTRACT_VERSION,
    CURRENT_RECORD_FORMAT,
    SHORTFALL_MARKER,
    buildCanonicalDecisionText,
    buildDecisionContractSummary,
    buildDecisionContractSnapshot,
    extractDecisionRecordFromText,
    extractDecisionRecordsFromText,
    extractStructuredDecisionPayload,
    formatDecisionRecordTable,
    getDecisionContractPrimaryRecord,
    getDecisionContractSecondaryRecord,
    getDecisionContractStatusScore,
    isShortfallMarkerLine,
    normalizeDecisionContractRecord,
    normalizeDecisionContractSummary,
    parseDecisionRecordLine,
    parseDecisionRecordParts,
    parseField10Meta,
    parseKpiScorecard,
    validateDecisionContractText
  };
});
