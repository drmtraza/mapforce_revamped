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

async function runSource(
  input: ResearchWorkflowInput,
  source: SourcePlan,
  python: PythonActivities,
): Promise<SourceOutcome> {
  const ref = { tenantId: input.tenantId, jobId: input.jobId, correlationId: input.correlationId };
  let invocation;
  try {
    invocation = await python.run_adapter({
      source_key: source.sourceKey,
      operation: source.operation,
      company: { domain: input.domain, name: input.companyName },
      budget: {
        max_records: input.budget.maxRecordsPerSource,
        max_evidence: input.budget.maxEvidencePerSource,
      },
      correlation_id: input.correlationId,
    });
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
  return control.persistSourceResult({
    ...ref,
    companyId: input.companyId,
    sourceKey: source.sourceKey,
    attempts: invocation.attempt,
    result: invocation.result,
  });
}

/**
 * Researches one company across configured sources. Sources run in parallel and
 * fail independently so one outage yields partial_success rather than losing results.
 */
export async function researchCompanyWorkflow(
  input: ResearchWorkflowInput,
): Promise<ResearchWorkflowResult> {
  const ref = { tenantId: input.tenantId, jobId: input.jobId, correlationId: input.correlationId };
  const start = await control.markJobRunning(ref);
  if (!start.proceed) {
    return { status: start.status === 'cancelled' ? 'cancelled' : 'failed', sources: [] };
  }

  const python = proxyActivities<PythonActivities>({
    taskQueue: input.pythonTaskQueue,
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '5 minutes',
    retry: {
      maximumAttempts: ADAPTER_MAX_ATTEMPTS,
      initialInterval: '2s',
      backoffCoefficient: 2,
      maximumInterval: '20s',
    },
  });

  try {
    const outcomes = await Promise.all(input.sources.map((s) => runSource(input, s, python)));
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
