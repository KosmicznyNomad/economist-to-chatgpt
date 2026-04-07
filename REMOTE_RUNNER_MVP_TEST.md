# Remote Runner MVP Smoke Test

This is the fastest manual test for the current Remote Runner MVP.

It assumes:
- the backend with `/api/v1/iskra/*` is running,
- both Chrome profiles have the unpacked extension loaded,
- Watchlist signing config is already set in the extension,
- the controller machine has supported source tabs open,
- the runner machine has ChatGPT available and logged in.

## What This Test Proves

If the smoke test passes, we know:
- controller can submit `manual_text` jobs to the central queue,
- backend keeps the queue as the source of truth,
- runner heartbeats and claims jobs,
- claimed jobs are converted into local queue jobs,
- executor runs with `promptChainSnapshot`,
- backend shows `queued -> claimed -> received -> started -> completed/failed`.

## Open The Right Consoles

On both machines:
1. Open `chrome://extensions`.
2. Find the extension.
3. Open the service worker inspector.
4. Run the snippets below in the service worker console.

## 1. Runner Machine: Enable Runner Mode

Run:

```js
await updateRemoteExecutionConfig({
  runnerEnabled: true,
  runnerName: 'runner-b'
})
```

Then confirm the local state:

```js
await getRemoteExecutionConfigSnapshot()
```

Expected:
- `runnerEnabled: true`
- `runnerId` is non-empty
- `promptsLoaded: true`
- `promptHash` is non-empty

Force one heartbeat/claim cycle:

```js
await runRemoteRunnerCycle('manual_smoke_boot')
```

List runners from the backend:

```js
await listRemoteRunnersViaApi({ limit: 10 })
```

Copy the `runnerId` from the local config or backend response. You will need it on the controller.

## 2. Controller Machine: Point To The Runner

Set controller mode to remote and choose the runner:

```js
await updateRemoteExecutionConfig({
  executionMode: 'remote',
  selectedRunnerId: 'PASTE_RUNNER_ID_HERE'
})
```

Check the config:

```js
await getRemoteExecutionConfigSnapshot()
```

Expected:
- `executionMode: 'remote'`
- `selectedRunnerId` matches the runner machine

## 3. Controller Machine: Submit A Remote Batch

Make sure at least one supported article tab is open.

Optional preflight:

```js
await collectSupportedAnalysisTabs()
```

Submit:

```js
await runAnalysis({
  remote: true,
  runnerId: 'PASTE_RUNNER_ID_HERE'
})
```

Expected:
- `success: true`
- `remote: true`
- `submittedCount > 0`
- `jobs.length > 0`

## 4. Backend Queue Check

On either machine, inspect the queue:

```js
await listRemoteJobsViaApi({
  runnerId: 'PASTE_RUNNER_ID_HERE',
  limit: 20
})
```

Immediately after submit you should usually see:
- one or more jobs with `status: 'queued'`

## 5. Runner Machine: Claim And Execute

Force a cycle if needed:

```js
await runRemoteRunnerCycle('manual_smoke_claim')
```

Check local runner state:

```js
await getRemoteExecutionConfigSnapshot()
```

Expected during execution:
- `localBusy: true`
- `queuedRemoteJobId` or `activeRemoteJobId` is non-empty

Check queue state:

```js
await getAnalysisQueueStatusSnapshot()
```

Expected:
- a job exists with `sourceUrl: 'manual://source'`
- the job carries remote metadata

## 6. Watch Remote Status Progress

Inspect all jobs:

```js
await listRemoteJobsViaApi({
  runnerId: 'PASTE_RUNNER_ID_HERE',
  limit: 20
})
```

Inspect a single job:

```js
await getRemoteJobViaApi('PASTE_JOB_ID_HERE')
```

Expected status progression:
- `queued`
- `claimed`
- `received`
- `started`
- `completed` or `failed`

For `completed`, inspect:
- `result.responseId`
- `result.conversationUrl`
- `result.dispatchState`
- `result.dispatchSummary`
- `result.copyTrace`
- `result.verifiedCount`

## 7. Busy Runner Scenario

This checks the main anti-conflict rule.

On the runner machine, enqueue any local analysis first so the local queue is not empty.
Then submit another remote batch from the controller.

Expected:
- runner heartbeat reports `localBusy: true`,
- the remote batch stays `queued` in backend,
- runner does not claim the new remote job until the local queue drains.

You can verify with:

```js
await getRemoteExecutionConfigSnapshot()
```

and:

```js
await listRemoteJobsViaApi({
  runnerId: 'PASTE_RUNNER_ID_HERE',
  status: 'queued',
  limit: 20
})
```

## 8. Service Worker Restart Scenario

While a job is queued or running:
1. close the service worker inspector,
2. let Chrome reload the worker,
3. reopen the inspector,
4. run:

```js
await getRemoteExecutionConfigSnapshot()
await getAnalysisQueueStatusSnapshot()
await runRemoteRunnerCycle('manual_smoke_after_restart')
```

Expected:
- remote config survives,
- local queue state survives,
- runner resumes heartbeat/claim behavior after restart.

## 9. Current Known Caveat

There is one important known limitation in the current MVP:
- if you manually cancel a waiting remote job from the local queue path,
- or manually stop an active remote process,
- backend status may not flip to terminal immediately.

In that case, the remote job will usually reconcile through lease expiry rather than an immediate terminal event.

So for the first smoke test, do not use manual stop/cancel as a pass/fail signal for correctness.

## 10. Quick Cleanup

Disable runner mode on the runner machine:

```js
await updateRemoteExecutionConfig({
  runnerEnabled: false
})
```

Switch the controller back to local mode:

```js
await updateRemoteExecutionConfig({
  executionMode: 'local',
  selectedRunnerId: ''
})
```
