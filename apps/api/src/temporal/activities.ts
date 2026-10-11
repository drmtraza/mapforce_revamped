import { withContext, type Db, type JobStatus, type JobType } from '@mapforce/db';
import type { EvidenceStorage } from '../modules/evidence/storage.ts';
import { recordAudit } from '../modules/audit/service.ts';
import { enqueueEvent } from '../modules/outbox/service.ts';
import {
  persistSourceResult,
  recordSourceFailure,
  type FailureInput,
  type PersistInput,
} from '../modules/research/persist.ts';
import {
  persistDiscoveryResult,
  type DiscoveryPersistInput,
} from '../modules/discovery/persist.ts';
import type { ResearchWorkflowResult, SourceOutcome } from './types.ts';

const TERMINAL: JobStatus[] = ['succeeded', 'partial_success', 'failed', 'cancelled'];

/** Event/audit naming per job type, e.g. research.started vs discovery.started. */
function naming(jobType: JobType) {
  if (jobType === 'company_discovery') {
    return {
      prefix: 'discovery',
      entityType: 'discovery_job',
      completedEvent: 'discovery.job.completed' as const,
    };
  }
  if (jobType === 'person_enrichment') {
    return {
      prefix: 'enrichment',
      entityType: 'enrich_job',
      completedEvent: 'enrichment.job.completed' as const,
    };
  }
  return {
    prefix: 'research',
    entityType: 'research_job',
    completedEvent: 'research.job.completed' as const,
  };
}

export interface JobRef {
  tenantId: string;
  jobId: string;
  correlationId: string;
}

export function createControlActivities(deps: { db: Db; storage: EvidenceStorage }) {
  const { db, storage } = deps;

  return {
    async markJobRunning(ref: JobRef): Promise<{ proceed: boolean; status: JobStatus }> {
      return withContext(db, { tenantId: ref.tenantId, userId: null }, async (trx) => {
        const job = await trx
          .selectFrom('workflow_jobs')
          .select(['status', 'job_type'])
          .where('tenant_id', '=', ref.tenantId)
          .where('id', '=', ref.jobId)
          .forUpdate()
          .executeTakeFirst();
        if (!job) throw new Error('Job not found');
        const names = naming(job.job_type);
        if (job.status === 'running') return { proceed: true, status: job.status };
        if (TERMINAL.includes(job.status)) return { proceed: false, status: job.status };
        if (job.status === 'cancel_requested') {
          await trx
            .updateTable('workflow_jobs')
            .set({ status: 'cancelled', finished_at: new Date() })
            .where('id', '=', ref.jobId)
            .execute();
          await trx
            .updateTable('workflow_job_sources')
            .set({ status: 'cancelled', finished_at: new Date() })
            .where('job_id', '=', ref.jobId)
            .where('status', 'in', ['pending', 'running'])
            .execute();
          return { proceed: false, status: 'cancelled' };
        }
        await trx
          .updateTable('workflow_jobs')
          .set((eb) => ({
            status: 'running',
            started_at: new Date(),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', ref.jobId)
          .execute();
        await trx
          .updateTable('workflow_job_sources')
          .set({ status: 'running', started_at: new Date() })
          .where('job_id', '=', ref.jobId)
          .where('status', '=', 'pending')
          .execute();
        await recordAudit(trx, {
          tenantId: ref.tenantId,
          actorUserId: null,
          action: `${names.prefix}.started`,
          entityType: names.entityType,
          entityId: ref.jobId,
          correlationId: ref.correlationId,
        });
        return { proceed: true, status: 'running' };
      });
    },

    async persistSourceResult(input: PersistInput): Promise<SourceOutcome> {
      return persistSourceResult(db, storage, input);
    },

    async recordSourceFailure(input: FailureInput): Promise<SourceOutcome> {
      return recordSourceFailure(db, input);
    },

    async persistDiscoveryResult(input: DiscoveryPersistInput): Promise<SourceOutcome> {
      return persistDiscoveryResult(db, storage, input);
    },

    async finalizeJob(
      input: JobRef & { outcomes: SourceOutcome[]; cancelled: boolean },
    ): Promise<ResearchWorkflowResult> {
      const succeeded = input.outcomes.filter((o) => o.status === 'succeeded').length;
      const status: ResearchWorkflowResult['status'] = input.cancelled
        ? 'cancelled'
        : succeeded === input.outcomes.length && succeeded > 0
          ? 'succeeded'
          : succeeded > 0
            ? 'partial_success'
            : 'failed';
      const failed = input.outcomes.filter((o) => o.status === 'failed');

      await withContext(db, { tenantId: input.tenantId, userId: null }, async (trx) => {
        const job = await trx
          .selectFrom('workflow_jobs')
          .select(['status', 'company_id', 'job_type'])
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.jobId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (TERMINAL.includes(job.status)) return;
        const names = naming(job.job_type);

        if (input.cancelled) {
          await trx
            .updateTable('workflow_job_sources')
            .set({ status: 'cancelled', finished_at: new Date() })
            .where('job_id', '=', input.jobId)
            .where('status', 'in', ['pending', 'running'])
            .execute();
        }
        await trx
          .updateTable('workflow_jobs')
          .set((eb) => ({
            status,
            finished_at: new Date(),
            result: JSON.stringify({ sources: input.outcomes }),
            error_code: status === 'failed' ? 'ALL_SOURCES_FAILED' : null,
            error_summary: failed.length
              ? `Failed sources: ${failed.map((f) => `${f.sourceKey} (${f.errorCode ?? 'error'})`).join(', ')}`
              : null,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', input.jobId)
          .execute();
        await enqueueEvent(trx, {
          tenantId: input.tenantId,
          eventType: names.completedEvent,
          correlationId: input.correlationId,
          idempotencyKey: input.jobId,
          payload: { job_id: input.jobId, company_id: job.company_id, status },
        });
        await recordAudit(trx, {
          tenantId: input.tenantId,
          actorUserId: null,
          action: `${names.prefix}.completed`,
          entityType: names.entityType,
          entityId: input.jobId,
          outcome: status === 'failed' ? 'failure' : 'success',
          correlationId: input.correlationId,
          metadata: { status, succeeded, failed: failed.length },
        });
      });
      return { status, sources: input.outcomes };
    },
  };
}

export type ControlActivities = ReturnType<typeof createControlActivities>;
