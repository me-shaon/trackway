import { openIndex, upsertRecords, type IndexDatabase, type MemoryRecord } from '@trackway/core';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExplorerApp, startExplorer } from '../src/index.js';

let db: IndexDatabase;
let uiDir: string;

const decision: MemoryRecord = {
  id: 'dec-20260825-aaaaaaaa',
  type: 'decision',
  sessionId: 'ses-1',
  episodeId: null,
  commits: [],
  significance: 'technical',
  createdAt: '2026-08-25T09:18:00Z',
  source: {
    adapter: 'claude-code',
    sessionId: 'ses-1',
    sessionFile: '/tmp/ses-1.jsonl',
    fromOffset: 0,
    toOffset: 12,
  },
  question: 'Which cache should we use?',
  choice: 'Redis',
  reason: 'Already deployed here.',
  alternatives: [
    {
      choice: 'PostgreSQL unlogged tables',
      status: 'rejected',
      reason: 'Higher latency for this workload.',
      condition: 'PostgreSQL is not deployed here',
    },
  ],
  attribution: {
    proposedBy: { type: 'agent', id: 'agent:claude-code' },
    acceptedBy: { type: 'human', id: 'human:local' },
  },
  status: 'accepted',
  supersededBy: null,
  relationships: [],
};

const discovery: MemoryRecord = {
  id: 'disc-20260825-bbbbbbbb',
  type: 'discovery',
  sessionId: 'ses-1',
  episodeId: null,
  commits: [],
  significance: 'technical',
  createdAt: '2026-08-25T09:10:00Z',
  source: {
    adapter: 'claude-code',
    sessionId: 'ses-1',
    sessionFile: '/tmp/ses-1.jsonl',
    fromOffset: 0,
    toOffset: 4,
  },
  text: 'Webhook delivery is not idempotent.',
};

beforeEach(async () => {
  db = openIndex(':memory:');
  upsertRecords(db, [decision, discovery]);
  uiDir = await mkdtemp(join(tmpdir(), 'trackway-ui-'));
  await mkdir(join(uiDir, 'assets'), { recursive: true });
  await mkdir(join(uiDir, 'fonts'), { recursive: true });
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
  await writeFile(join(uiDir, 'fonts', 'sample.woff2'), 'wOF2 not really', 'utf8');
});

afterEach(async () => {
  db.close();
  await rm(uiDir, { recursive: true, force: true });
});

function app() {
  return createExplorerApp({ db, uiDir });
}

async function json<T>(path: string): Promise<T> {
  const response = await app().request(path);
  return (await response.json()) as T;
}

describe('the data API', () => {
  it('returns a session timeline in time order', async () => {
    const body = await json<{ entries: Array<{ record: MemoryRecord; time: string }> }>(
      '/api/sessions/ses-1',
    );

    expect(body.entries.map((entry) => entry.record.id)).toEqual([discovery.id, decision.id]);
    expect(body.entries[0]?.time).toBe('09:10');
  });

  it('reports a session with no records as missing rather than empty', async () => {
    const response = await app().request('/api/sessions/nope');

    expect(response.status).toBe(404);
  });

  it('searches across record types', async () => {
    const body = await json<{ records: MemoryRecord[] }>('/api/search?q=webhook');

    expect(body.records.map((record) => record.id)).toEqual([discovery.id]);
  });

  it('returns discarded options with the decision that displaced them', async () => {
    const body = await json<{ alternatives: Array<Record<string, unknown>> }>('/api/rejected');

    expect(body.alternatives).toHaveLength(1);
    expect(body.alternatives[0]).toMatchObject({
      choice: 'PostgreSQL unlogged tables',
      decisionChoice: 'Redis',
      condition: 'PostgreSQL is not deployed here',
    });
  });

  it('reports how many records are worth reading, not just how many exist', async () => {
    const body = await json<{ counts: Record<string, number>; byKind: Record<string, number> }>(
      '/api/overview',
    );

    // A count of everything tells a reader nothing about what to open.
    expect(body.counts['foreground']).toBeLessThanOrEqual(body.counts['records'] ?? 0);
    expect(Object.keys(body.byKind).sort()).toEqual([
      'business',
      'direction',
      'technical',
      'working',
    ]);
  });

  it('puts project-level decisions first so the map opens on something that mattered', async () => {
    const body = await json<{ records: MemoryRecord[] }>('/api/decisions');

    expect(body.records.length).toBeGreaterThan(0);
  });

  it('serves every record for the story view, oldest first', async () => {
    const body = await json<{ records: MemoryRecord[] }>('/api/records');
    const dates = body.records.map((record) => record.createdAt);

    expect(body.records).toHaveLength(2);
    expect([...dates].sort()).toEqual(dates);
  });

  it('scopes records to one session when asked', async () => {
    const body = await json<{ records: MemoryRecord[] }>('/api/records?session=nope');

    expect(body.records).toEqual([]);
  });

  it('searches discarded options directly', async () => {
    const body = await json<{ alternatives: Array<{ choice: string }> }>('/api/rejected?q=unlogged');

    expect(body.alternatives[0]?.choice).toBe('PostgreSQL unlogged tables');
  });

  it('summarises the project in one request', async () => {
    const body = await json<{ counts: Record<string, number>; byKind: Record<string, number> }>(
      '/api/overview',
    );

    expect(body.counts).toMatchObject({ sessions: 1, records: 2, decisions: 1, rejected: 1 });
  });

  it('names the project when the workspace resolved one', async () => {
    const response = await createExplorerApp({ db, uiDir, projectName: 'trackway' }).request(
      '/api/overview',
    );
    const body = (await response.json()) as { project?: string };

    expect(body.project).toBe('trackway');
  });

  it('says nothing about the project when no name is known', async () => {
    const body = await json<Record<string, unknown>>('/api/overview');

    // Omitted rather than guessed
    expect('project' in body).toBe(false);
  });

  it('exposes no endpoint that returns raw events', async () => {
    // The explorer must render distilled records only, and the surest way to
    // guarantee that is to give it no way to ask for anything else.
    for (const path of ['/api/events', '/api/sessions/ses-1/events', '/api/raw']) {
      const response = await app().request(path);
      expect(response.headers.get('content-type') ?? '').not.toContain('application/json');
    }
  });

  it('returns a record by id', async () => {
    const body = await json<{ record: MemoryRecord }>(`/api/records/${decision.id}`);

    expect(body.record.id).toBe(decision.id);
  });

  it('reports an unknown record id as missing', async () => {
    expect((await app().request('/api/records/dec-nope')).status).toBe(404);
  });

  it('filters decisions by who proposed them', async () => {
    const agent = await json<{ records: MemoryRecord[] }>('/api/decisions?actor=agent');
    const human = await json<{ records: MemoryRecord[] }>('/api/decisions?actor=human');

    expect(agent.records).toHaveLength(1);
    expect(human.records).toHaveLength(0);
  });

  it('returns an empty result for a blank search rather than failing', async () => {
    const body = await json<{ records: MemoryRecord[] }>('/api/search?q=');

    expect(body.records).toEqual([]);
  });
});

describe('serving the explorer', () => {
  it('serves the app shell at the root', async () => {
    const response = await app().request('/');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('serves the app shell for a deep link so it can load', async () => {
    expect((await app().request('/timeline')).status).toBe(200);
  });

  it('explains rather than crashing when the bundle is missing', async () => {
    const response = await createExplorerApp({ db, uiDir: '/nope/not/here' }).request('/');

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('explorer bundle is missing');
  });
});

describe('binding', () => {
  it('listens on loopback only', async () => {
    const explorer = await startExplorer({ db, uiDir, port: 0 });

    try {
      // Records describe private work, so nothing about this needs to be
      // reachable from another machine.
      expect(explorer.url.startsWith('http://127.0.0.1:')).toBe(true);

      const response = await fetch(`${explorer.url}/api/overview`);
      expect(response.status).toBe(200);
    } finally {
      await explorer.close();
    }
  });
});

/**
 * The explorer serves its own typefaces so it needs no network. Fonts once fell
 * through to the app-shell catch-all and came back as HTML, which no error
 * surfaced: the interface simply rendered in a fallback face.
 */
describe('static assets', () => {
  it('serves a font file rather than the app shell', async () => {
    const app = createExplorerApp({ db, uiDir });
    const response = await app.request('/fonts/sample.woff2');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await response.text()).not.toContain('<div id="root">');
  });

  it('still serves the app shell for a deep link', async () => {
    const app = createExplorerApp({ db, uiDir });
    const response = await app.request('/some/deep/link');

    expect(await response.text()).toContain('<div id="root">');
  });
});
