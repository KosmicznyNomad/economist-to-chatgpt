const assert = require('assert');

const WatchlistDispatchShapeUtils = require('./watchlist-dispatch-shape.js');

function testDispatchShapeNormalizesDecisionRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeWatchlistDecisionRecords([
    {
      recordFormat: 'current_17_role',
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
      currency: 'USD',
      kpiScorecard: 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
    },
    null
  ]);

  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0], {
    recordFormat: 'current_17_role',
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
    currency: 'USD',
    kpiScorecard: 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  });
}

function main() {
  testDispatchShapeNormalizesDecisionRecords();
  console.log('test-watchlist-dispatch-shape.js: ok');
}

main();
