import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from '@temporalio/client';
import type {
  DiscoveryWorkflowInput,
  EnrichmentWorkflowInput,
  ResearchWorkflowInput,
} from './types.ts';

export interface ResearchDispatcher {
  start(input: ResearchWorkflowInput): Promise<void>;
  startDiscovery(input: DiscoveryWorkflowInput): Promise<void>;
  startEnrichment(input: EnrichmentWorkflowInput): Promise<void>;
  cancel(workflowId: string): Promise<void>;
}

export function researchWorkflowId(jobId: string): string {
  return `research-${jobId}`;
}

export function discoveryWorkflowId(jobId: string): string {
  return `discovery-${jobId}`;
}

export function enrichmentWorkflowId(jobId: string): string {
  return `enrich-${jobId}`;
}

export function createTemporalDispatcher(client: Client, taskQueue: string): ResearchDispatcher {
  const startOnce = async (workflow: string, workflowId: string, input: unknown) => {
    try {
      await client.workflow.start(workflow, {
        taskQueue,
        workflowId,
        args: [input],
        workflowExecutionTimeout: '30 minutes',
      });
    } catch (err) {
      // Redelivered outbox events must not start a second execution.
      if (err instanceof WorkflowExecutionAlreadyStartedError) return;
      throw err;
    }
  };
  return {
    async start(input) {
      await startOnce('researchCompanyWorkflow', researchWorkflowId(input.jobId), input);
    },
    async startDiscovery(input) {
      await startOnce('discoverCompaniesWorkflow', discoveryWorkflowId(input.jobId), input);
    },
    async startEnrichment(input) {
      await startOnce('enrichPersonWorkflow', enrichmentWorkflowId(input.jobId), input);
    },
    async cancel(workflowId) {
      try {
        await client.workflow.getHandle(workflowId).cancel();
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return;
        throw err;
      }
    },
  };
}
