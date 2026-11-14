import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  alice.workspaceId = (
    await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Tenders' } })
  ).body.id;
  bob.workspaceId = (
    await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Tenders' } })
  ).body.id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('tenders and competitors', () => {
  it('syncs mock tenders, assesses bid, and records human decision', async () => {
    const sync = await call(env, alice, 'POST', '/api/v1/tenders/sync-mock');
    expect(sync.status).toBe(200);
    expect(sync.body.upserted).toBeGreaterThanOrEqual(2);
    expect(sync.body.note).toMatch(/Mock tender/i);

    const list = await call(env, alice, 'GET', '/api/v1/tenders');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    const tenderId = list.body.data[0].id as string;

    const assess = await call(env, alice, 'POST', `/api/v1/tenders/${tenderId}/bid-assessments`);
    expect(assess.status).toBe(201);
    expect(assess.body.note).toMatch(/never auto-submits/i);
    expect(assess.body.human_decision).toBeNull();

    const decided = await call(
      env,
      alice,
      'PATCH',
      `/api/v1/tender-bid-assessments/${assess.body.id}`,
      { body: { human_decision: 'defer' } },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.human_decision).toBe('defer');
  });

  it('creates competitor battlecard without fabricating certifications', async () => {
    const competitor = await call(env, alice, 'POST', '/api/v1/competitors', {
      body: { name: 'RivalSec', domain: 'rivalsec.example' },
    });
    expect(competitor.status).toBe(201);

    const card = await call(
      env,
      alice,
      'POST',
      `/api/v1/competitors/${competitor.body.id}/battlecards`,
      {
        body: {
          strengths: 'Broad brand recognition in mid-market.',
          weaknesses: 'Slow professional services delivery.',
          our_differentiators: 'Evidence-backed account intelligence workflows.',
          claim_type: 'user_assertion',
          evidence_ids: [],
        },
      },
    );
    expect(card.status).toBe(201);
    expect(card.body.certifications_note).toMatch(/without evidence/i);
    expect(card.body.version).toBe(1);

    const sourcedBad = await call(
      env,
      alice,
      'POST',
      `/api/v1/competitors/${competitor.body.id}/battlecards`,
      {
        body: {
          strengths: 'Claimed ISO without proof',
          weaknesses: 'n/a',
          our_differentiators: 'n/a',
          claim_type: 'source_fact',
          evidence_ids: [],
        },
      },
    );
    expect(sourcedBad.status).toBe(400);
  });

  it('isolates alice tenders from bob', async () => {
    const bobList = await call(env, bob, 'GET', '/api/v1/tenders');
    expect(bobList.status).toBe(200);
    expect(bobList.body.data).toEqual([]);
  });
});
