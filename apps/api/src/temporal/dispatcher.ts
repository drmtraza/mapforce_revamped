import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from '@temporalio/client';
import type { ResearchWorkflowInput } from './types.ts';

export interface ResearchDispatcher {
  start(input: ResearchWorkflowInput): Promise<void>;
  cancel(workflowId: string): Promise<void>;
}

export function researchWorkflowId(jobId: string): string {
  return `research-${jobId}`;
}

export function createTemporalDispatcher(client: Client, taskQueue: string): ResearchDispatcher {
  return {
    async start(input) {
      try {
        await client.workflow.start('researchCompanyWorkflow', {
          taskQueue,
          workflowId: researchWorkflowId(input.jobId),
          args: [input],
          workflowExecutionTimeout: '30 minutes',
        });
      } catch (err) {
        // Redelivered outbox events must not start a second execution.
        if (err instanceof WorkflowExecutionAlreadyStartedError) return;
        throw err;
      }
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
