const assert = require('assert');

const ProcessContractUtils = require('./process-contract.js');

function testMergeProcessPerformanceTelemetryTracksPhaseDurationsAndPromptGaps() {
  const merged = ProcessContractUtils.mergeProcessPerformanceTelemetry(
    {
      lifecycleStatus: 'running',
      phase: 'response_wait',
      phaseStartedAt: 1000,
      currentPrompt: 1,
      performanceTelemetry: {
        phaseTotalsMs: {
          prompt_send: 800
        },
        promptTimings: {
          count: 1,
          firstAt: 1500,
          lastAt: 2000,
          lastPromptNumber: 1,
          gapCount: 0,
          totalGapMs: 0,
          maxGapMs: 0,
          lastGapMs: 0
        },
        phaseTransitionCount: 2
      }
    },
    {
      lifecycleStatus: 'running',
      phase: 'prompt_send',
      currentPrompt: 2
    },
    {
      nowTs: 5000,
      previousPhase: 'response_wait',
      nextPhase: 'prompt_send',
      nextLifecycleStatus: 'running'
    }
  );

  assert(merged);
  assert.strictEqual(merged.phaseTotalsMs.prompt_send, 800);
  assert.strictEqual(merged.phaseTotalsMs.response_wait, 4000);
  assert.strictEqual(merged.phaseTransitionCount, 3);
  assert.strictEqual(merged.promptTimings.count, 2);
  assert.strictEqual(merged.promptTimings.gapCount, 1);
  assert.strictEqual(merged.promptTimings.totalGapMs, 3000);
  assert.strictEqual(merged.promptTimings.maxGapMs, 3000);
  assert.strictEqual(merged.promptTimings.lastGapMs, 3000);
  assert.strictEqual(merged.promptTimings.lastPromptNumber, 2);
  assert.strictEqual(merged.promptTimings.lastAt, 5000);
}

function testBuildProcessPerformanceSnapshotFlagsSlowActiveProcess() {
  const snapshot = ProcessContractUtils.buildProcessPerformanceSnapshot(
    {
      lifecycleStatus: 'running',
      phase: 'response_wait',
      startedAt: 1000,
      phaseStartedAt: 2000,
      lastActivityAt: 2000,
      currentPrompt: 6,
      performanceTelemetry: {
        phaseTotalsMs: {
          prompt_send: 6000,
          payload_send: 2000
        },
        promptTimings: {
          count: 6,
          firstAt: 3000,
          lastAt: 10_000,
          lastPromptNumber: 6,
          gapCount: 5,
          totalGapMs: 250_000,
          maxGapMs: 70_000,
          lastGapMs: 70_000
        },
        phaseTransitionCount: 8
      }
    },
    {
      nowTs: 20 * 60 * 1000
    }
  );

  assert(snapshot);
  assert.strictEqual(snapshot.highestSeverity, 'error');
  assert(snapshot.problems.some((problem) => problem.code === 'phase_slow'));
  assert(snapshot.problems.some((problem) => problem.code === 'stale_activity'));
  assert(snapshot.problems.some((problem) => problem.code === 'prompt_gap'));
  assert.strictEqual(snapshot.promptCount, 6);
  assert.strictEqual(snapshot.promptGapCount, 5);
  assert.strictEqual(snapshot.promptGapMaxMs, 70_000);
  assert.strictEqual(snapshot.phaseTotalsMs.response_wait, (20 * 60 * 1000) - 2000);
}

function main() {
  testMergeProcessPerformanceTelemetryTracksPhaseDurationsAndPromptGaps();
  testBuildProcessPerformanceSnapshotFlagsSlowActiveProcess();
  console.log('test-process-performance-diagnostics.js passed');
}

main();
