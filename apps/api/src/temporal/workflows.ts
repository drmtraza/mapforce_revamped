import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
  TimeoutFailure,
} from '@temporalio/workflow';
import type { ControlActivities } from './activities.ts';
import type {
  AdapterInvocation,
  AdapterRequest,
  DiscoveryWorkflowInput,
  PythonActivities,
  ResearchWorkflowInput,
  ResearchWorkflowResult,
  SourceOutcome,
  SourcePlan,
} from './types.ts';

const ADAPTER_MAX_ATTEMPTS = 3;

const control = proxyActivities<ControlActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

function describeFailure(err: unknown): { code: string; message: string; attempts: number } {
  let attempts = 0;
  let cause: unknown = err;
  if (err instanceof ActivityFailure) {
    attempts = err.retryState === 'MAXIMUM_ATTEMPTS_REACHED' ? ADAPTER_MAX_ATTEMPTS : 1;
    cause = err.cause;
  }
  if (cause instanceof ApplicationFailure) {
    const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(cause.type ?? '')
      ? (cause.type as string)
      : 'ADAPTER_ERROR';
    return { code, message: cause.message.slice(0, 300), attempts };
  }
  if (cause instanceof TimeoutFailure) {
    return {
      code: 'SOURCE_TIMEOUT',
      message: 'Source did not respond within the time budget.',
      attempts,
    };
  }
  return { code: 'ADAPTER_ERROR', message: 'Adapter failed.', attempts };
}

function pythonActivities(taskQueue: string): PythonActivities {
  return proxyActivities<PythonActivities>({
    taskQueue,
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '5 minutes',
    // Adapters heartbeat while working; a silent worker is retried and cancellation is delivered.
    heartbeatTimeout: '20 seconds',
    retry: {
      maximumAttempts: ADAPTER_MAX_ATTEMPTS,
      initialInterval: '2s',
      backoffCoefficient: 2,
      maximumInterval: '20s',
    },
  });
}

type JobRef = { tenantId: string; jobId: string; correlationId: string };

async function runSource(
  ref: JobRef,
  source: SourcePlan,
  request: AdapterRequest,
  python: PythonActivities,
  persist: (invocation: AdapterInvocation) => Promise<SourceOutcome>,
): Promise<SourceOutcome> {
  let invocation;
  try {
    invocation = await python.run_adapter(request);
  } catch (err) {
    if (isCancellation(err)) throw err;
    const failure = describeFailure(err);
    return control.recordSourceFailure({
      ...ref,
      sourceKey: source.sourceKey,
      attempts: failure.attempts,
      errorCode: failure.code,
      errorSummary: failure.message,
    });
  }
  return persist(invocation);
}

async function runJob(
  ref: JobRef,
  run: () => Promise<SourceOutcome[]>,
): Promise<ResearchWorkflowResult> {
  const start = await control.markJobRunning(ref);
  if (!start.proceed) {
    return { status: start.status === 'cancelled' ? 'cancelled' : 'failed', sources: [] };
  }
  try {
    const outcomes = await run();
    return await control.finalizeJob({ ...ref, outcomes, cancelled: false });
  } catch (err) {
    if (isCancellation(err)) {
      return CancellationScope.nonCancellable(() =>
        control.finalizeJob({ ...ref, outcomes: [], cancelled: true }),
      );
    }
    throw err;
  }
}

function budgetFor(
  source: SourcePlan,
  budget: { maxRecordsPerSource: number; maxEvidencePerSource: number },
) {
  return {
    max_records: source.maxRecords ?? budget.maxRecordsPerSource,
    max_evidence: source.maxEvidence ?? budget.maxEvidencePerSource,
  };
}

/**
 * Researches one company across configured sources. Sources run in parallel and
 * fail independently so one outage yields partial_success rather than losing results.
 */
export async function researchCompanyWorkflow(
  input: ResearchWorkflowInput,
): Promise<ResearchWorkflowResult> {
  const ref = { tenantId: input.tenantId, jobId: input.jobId, correlationId: input.correlationId };
  const python = pythonActivities(input.pythonTaskQueue);
  return runJob(ref, () =>
    Promise.all(
      input.sources.map((s) =>
        runSource(
          ref,
          s,
          {
            source_key: s.sourceKey,
            operation: s.operation,
            company: { domain: input.domain, name: input.companyName },
            budget: budgetFor(s, input.budget),
            correlation_id: input.correlationId,
          },
          python,
          (invocation) =>
            control.persistSourceResult({
              ...ref,
              companyId: input.companyId,
              sourceKey: s.sourceKey,
              attempts: invocation.attempt,
              result: invocation.result,
            }),
        ),
      ),
    ),
  );
}

/** Searches discovery sources for candidate companies; candidates are reviewed by a person. */
export async function discoverCompaniesWorkflow(
  input: DiscoveryWorkflowInput,
): Promise<ResearchWorkflowResult> {
  const ref = { tenantId: input.tenantId, jobId: input.jobId, correlationId: input.correlationId };
  const python = pythonActivities(input.pythonTaskQueue);
  return runJob(ref, () =>
    Promise.all(
      input.sources.map((s) =>
        runSource(
          ref,
          s,
          {
            source_key: s.sourceKey,
            operation: s.operation,
            query: input.query,
            budget: budgetFor(s, input.budget),
            correlation_id: input.correlationId,
          },
          python,
          (invocation) =>
            control.persistDiscoveryResult({
              ...ref,
              sourceKey: s.sourceKey,
              attempts: invocation.attempt,
              result: invocation.result,
            }),
        ),
      ),
    ),
  );
}
