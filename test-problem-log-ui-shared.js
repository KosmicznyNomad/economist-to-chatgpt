const assert = require('assert');

const sentMessages = [];
global.chrome = {
  runtime: {
    sendMessage(message, callback) {
      sentMessages.push(message);
      if (typeof callback === 'function') callback();
    }
  }
};

const ProblemLogUiUtils = require('./problem-log-ui-shared.js');

function testSummarizeClientErrorValueNormalizesErrors() {
  const error = new Error('boom');
  const summary = ProblemLogUiUtils.summarizeClientErrorValue(error);
  assert.ok(summary.includes('boom'));
}

function testReportProblemLogFromUiUsesSharedPayloadShape() {
  sentMessages.length = 0;

  ProblemLogUiUtils.reportProblemLogFromUi({
    title: 'Broken refresh',
    reason: 'fetch_failed',
    error: 'timeout',
    status: 'failed',
    level: 'warning',
    tabId: 7
  }, {
    defaultSource: 'process-monitor-ui',
    defaultMessage: 'process_monitor_problem',
    signatureNamespace: 'process-monitor-ui'
  });

  assert.strictEqual(sentMessages.length, 1);
  assert.deepStrictEqual(sentMessages[0], {
    type: 'REPORT_PROBLEM_LOG',
    entry: {
      level: 'warn',
      source: 'process-monitor-ui',
      title: 'Broken refresh',
      status: 'failed',
      reason: 'fetch_failed',
      error: 'timeout',
      message: 'process_monitor_problem',
      signature: 'process-monitor-ui|process-monitor-ui|Broken refresh|fetch_failed|timeout|process_monitor_problem',
      tabId: 7,
      windowId: null
    }
  });
}

function main() {
  testSummarizeClientErrorValueNormalizesErrors();
  testReportProblemLogFromUiUsesSharedPayloadShape();
  console.log('test-problem-log-ui-shared.js: ok');
}

main();
