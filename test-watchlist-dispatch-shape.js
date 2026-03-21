const assert = require('assert');

const WatchlistDispatchShapeUtils = require('./watchlist-dispatch-shape.js');

function testDispatchShapeNormalizesDecisionRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeWatchlistDecisionRecords([
    {
      recordFormat: 'current_16_role',
      decisionDate: '2026-03-20',
      decisionStatus: 'WATCH',
      decisionRole: 'PRIMARY',
      company: 'Alpha Corp (ALFA)',
      sourceMaterial: 'Source',
      thesis: 'Thesis',
      asymmetry: '',
      bear: 'Bear_TOTAL: 10',
      base: 'Base_TOTAL: 20',
      bull: 'Bull_TOTAL: 30',
      voi: 'VOI: ok',
      sector: 'Technology',
      companyFamily: '',
      companyType: 'Software',
      revenueModel: 'Subscription',
      region: 'USA',
      currency: 'USD'
    },
    null
  ]);

  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0], {
    recordFormat: 'current_16_role',
    decisionDate: '2026-03-20',
    decisionStatus: 'WATCH',
    decisionRole: 'PRIMARY',
    company: 'Alpha Corp (ALFA)',
    sourceMaterial: 'Source',
    thesis: 'Thesis',
    asymmetry: '',
    bear: 'Bear_TOTAL: 10',
    base: 'Base_TOTAL: 20',
    bull: 'Bull_TOTAL: 30',
    voi: 'VOI: ok',
    sector: 'Technology',
    companyFamily: 'Technology',
    companyType: 'Software',
    revenueModel: 'Subscription',
    region: 'USA',
    currency: 'USD'
  });
}

function main() {
  testDispatchShapeNormalizesDecisionRecords();
  console.log('test-watchlist-dispatch-shape.js: ok');
}

main();
