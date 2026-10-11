import type { Logger } from 'pino';
import type { Db } from '@mapforce/db';
import type { ResearchDispatcher } from '../../temporal/dispatcher.ts';
import type { ResearchWorkflowInput } from '../../temporal/types.ts';

export const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 5 * 60_000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 20));
  return Math.round(base / 2 + random() * (base / 2));
}

type Handler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Handlers per event type. Events without a Phase 1 subscriber are acknowledged
 * so the outbox does not grow unbounded; they remain queryable for replay.
 */
function handlers(dispatcher: ResearchDispatcher): Partial<Record<string, Handler>> {
  return {
    'research.company.requested': async (payload) => {
      const input = payload.workflow_input as ResearchWorkflowInput | undefined;
      if (!input?.jobId || !input.tenantId) throw new Error('workflow_input missing from payload');
      await dispatcher.start(input);
    },
  };
}

/** Delivers one batch of due events. Rows are locked with SKIP LOCKED so relays can scale out. */
export async function relayOnce(
  relayDb: Db,
  dispatcher: ResearchDispatcher,
  logger: Pick<Logger, 'warn' | 'error'>,
  batchSize = 20,
): Promise<number> {
  const table = handlers(dispatcher);
  return relayDb.transaction().execute(async (trx) => {
    const events = await trx
      .selectFrom('outbox_events')
      .select(['id', 'tenant_id', 'event_type', 'payload', 'attempts'])
      .where('published_at', 'is', null)
      .where('dead_lettered_at', 'is', null)
      .where('next_attempt_at', '<=', new Date())
      .orderBy('next_attempt_at')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const event of events) {
      const handler = table[event.event_type];
      try {
        if (handler) await handler(event.payload as Record<string, unknown>);
        await trx
          .updateTable('outbox_events')
          .set({ published_at: new Date(), attempts: event.attempts + 1, last_error: null })
          .where('id', '=', event.id)
          .execute();
      } catch (err) {
        const attempts = event.attempts + 1;
        const message = (err as Error).message.slice(0, 500);
        const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
        (dead ? logger.error : logger.warn).call(
          logger,
          {
            event_id: event.id,
            event_type: event.event_type,
            tenant_id: event.tenant_id,
            attempts,
          },
          dead ? 'outbox event dead-lettered' : 'outbox delivery failed; will retry',
        );
        await trx
          .updateTable('outbox_events')
          .set({
            attempts,
            last_error: message,
            next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
            dead_lettered_at: dead ? new Date() : null,
          })
          .where('id', '=', event.id)
          .execute();
      }
    }
    return events.length;
  });
}

export function startRelayLoop(
  relayDb: Db,
  dispatcher: ResearchDispatcher,
  logger: Pick<Logger, 'warn' | 'error'>,
  idleMs = 1000,
): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      let delivered = 0;
      try {
        delivered = await relayOnce(relayDb, dispatcher, logger);
      } catch (err) {
        logger.error({ err }, 'outbox relay iteration failed');
      }
      if (delivered === 0) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
