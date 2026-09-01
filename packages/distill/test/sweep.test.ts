import { AdapterRegistry, type AdapterCapabilities, type SessionAdapter } from '@trackway/adapters';
import type { MemoryEvent, MemoryRecord, SessionDescriptor } from '@trackway/core';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessEligibility,
  emptyState,
  isQuiet,
  loadState,
  purgeCache,
  markPartial,
  partialFailures,
  partialReasons,
  runSweep,
  saveState,
  stateKey,
  type Distiller,
  type SweepProgress,
} from '../src/index.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'trackway-sweep-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: 'ses-1',
    adapter: 'fake',
    sessionFile: '/tmp/ses-1.jsonl',
    cwd: '/repo',
    branch: 'main',
    lastModified: minutesAgo(60),
    formatVersion: 'fake-v1',
    ...overrides,
  };
}

function eventAt(offset: number, sessionId = 'ses-1'): MemoryEvent {
  return {
    id: `fake:${sessionId}:${offset}`,
    sessionId,
    timestamp: minutesAgo(60),
    type: 'user_prompt',
    actor: { type: 'human', id: 'human:local' },
    payload: { text: `event ${offset}` },
    source: { adapter: 'fake', sessionFile: `/tmp/${sessionId}.jsonl`, offset },
  };
}

function recordFor(sessionId: string, id: string): MemoryRecord {
  return {
    id,
    type: 'discovery',
    sessionId,
    episodeId: null,
    commits: [],
    significance: 'technical',
    createdAt: NOW.toISOString(),
    source: {
      adapter: 'fake',
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      fromOffset: 0,
      toOffset: 5,
    },
    text: 'Something worth remembering.',
  };
}

class FakeAdapter implements SessionAdapter {
  readonly capabilities: AdapterCapabilities;
  readSessionCalls: Array<{ sessionId: string; fromOffset: number | undefined }> = [];

  constructor(
    readonly id: string,
    private descriptors: SessionDescriptor[],
    private readonly events: Map<string, MemoryEvent[]>,
    capabilities: Partial<AdapterCapabilities> = {},
    private readonly failOn?: string,
  ) {
    this.capabilities = {
      canDistill: true,
      suppliesRedaction: false,
      supportsHook: true,
      ...capabilities,
    };
  }

  async isAvailable() {
    return { available: true };
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    return this.descriptors;
  }

  async readSession(d: SessionDescriptor, options?: { fromOffset?: number }) {
    this.readSessionCalls.push({ sessionId: d.sessionId, fromOffset: options?.fromOffset });

    if (this.failOn === d.sessionId) throw new Error('session file vanished');

    const all = this.events.get(d.sessionId) ?? [];
    const from = options?.fromOffset ?? -1;
    return all.filter((e) => e.source.offset > from);
  }

  setDescriptors(next: SessionDescriptor[]): void {
    this.descriptors = next;
  }
}

function countingDistiller(): Distiller & { calls: number } {
  const fn = (async ({ descriptor: d, events }) => {
    fn.calls += 1;
    return events.map((e) => recordFor(d.sessionId, `disc-${d.sessionId}-${e.source.offset}`));
  }) as Distiller & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('quiet detection', () => {
  // Covers AE5.
  it('skips a session still being written and takes one that has gone quiet', () => {
    const active = assessEligibility(descriptor({ lastModified: minutesAgo(3) }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
    });
    const quiet = assessEligibility(descriptor({ lastModified: minutesAgo(30) }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(active.eligible).toBe(false);
    expect(active.reason).toBe('still-active');
    expect(quiet.eligible).toBe(true);
  });

  it('treats a session exactly at the quiet window as eligible', () => {
    expect(isQuiet(minutesAgo(15), { quietWindowMinutes: 15, now: NOW })).toBe(true);
    expect(isQuiet(minutesAgo(14), { quietWindowMinutes: 15, now: NOW })).toBe(false);
  });

  it('treats an unparseable timestamp as still active rather than distilling it', () => {
    expect(isQuiet('not a date', { quietWindowMinutes: 15, now: NOW })).toBe(false);
  });

  it('skips a session already distilled with no new content', () => {
    const d = descriptor();
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: 10,
      lastSeenModified: d.lastModified,
      lastSweptAt: NOW.toISOString(),
      lastError: null,
      failureCount: 0,
    };

    const assessment = assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('already-distilled');
  });

  it('takes a session again once it has grown since the last sweep', () => {
    const d = descriptor({ lastModified: minutesAgo(20) });
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: 10,
      lastSeenModified: minutesAgo(90),
      lastSweptAt: minutesAgo(80),
      lastError: null,
      failureCount: 0,
    };

    expect(assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW }).eligible).toBe(true);
  });

  it('excludes sessions from another repository', () => {
    const assessment = assessEligibility(descriptor({ cwd: '/elsewhere' }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('other-repository');
  });

  it('excludes a session with no recorded working directory when filtering by repo', () => {
    const assessment = assessEligibility(descriptor({ cwd: null }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.reason).toBe('no-working-directory');
  });

  it('includes a session in a subdirectory of the repository', () => {
    const assessment = assessEligibility(descriptor({ cwd: '/repo/packages/core' }), emptyState(), {
      quietWindowMinutes: 15,
      now: NOW,
      repoRoot: '/repo',
    });

    expect(assessment.eligible).toBe(true);
  });

  it('stops retrying a session that keeps failing', () => {
    const d = descriptor();
    const state = emptyState();
    state.sessions[stateKey(d.adapter, d.sessionId)] = {
      sessionId: d.sessionId,
      adapter: d.adapter,
      watermark: -1,
      lastSeenModified: minutesAgo(200),
      lastSweptAt: minutesAgo(100),
      lastError: 'model returned invalid JSON',
      failureCount: 3,
    };

    const assessment = assessEligibility(d, state, { quietWindowMinutes: 15, now: NOW });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toBe('repeatedly-failed');
  });
});

describe('running a sweep', () => {
  function setup(options: { capabilities?: Partial<AdapterCapabilities>; failOn?: string } = {}) {
    const events = new Map([['ses-1', [eventAt(0), eventAt(1), eventAt(2)]]]);
    const adapter = new FakeAdapter(
      'fake',
      [descriptor()],
      events,
      options.capabilities,
      options.failOn,
    );
    return { adapter, registry: new AdapterRegistry([adapter]) };
  }

  it('distils a quiet session and returns its records', async () => {
    const { registry } = setup();
    const distill = countingDistiller();

    const result = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]?.records).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  // Covers AE2, AE6.
  it('produces no new work on a second sweep with nothing changed', async () => {
    const { registry } = setup();
    const distill = countingDistiller();
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    const first = await runSweep(registry, distill, options);
    const second = await runSweep(registry, distill, options);

    expect(first.swept).toHaveLength(1);
    expect(second.swept).toHaveLength(0);
    expect(second.skipped[0]?.reason).toBe('already-distilled');
    expect(distill.calls).toBe(1);
  });

  // Covers AE6.
  it('distils only content past the watermark when a session continues', async () => {
    const events = new Map([['ses-1', [eventAt(0), eventAt(1)]]]);
    const adapter = new FakeAdapter('fake', [descriptor()], events);
    const registry = new AdapterRegistry([adapter]);
    const distill = countingDistiller();

    await runSweep(registry, distill, { cacheDir, quietWindowMinutes: 15, now: NOW });

    // The session grew and went quiet again.
    events.set('ses-1', [eventAt(0), eventAt(1), eventAt(2), eventAt(3)]);
    adapter.setDescriptors([descriptor({ lastModified: minutesAgo(20) })]);

    const second = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(second.swept[0]?.eventCount).toBe(2);
    expect(second.swept[0]?.records.map((r) => r.id)).toEqual([
      'disc-ses-1-2',
      'disc-ses-1-3',
    ]);
    expect(adapter.readSessionCalls.at(-1)?.fromOffset).toBe(1);
  });

  // Covers AE7.
  it('reads and marks undistilled for an adapter that cannot distil', async () => {
    const { registry } = setup({ capabilities: { canDistill: false } });
    const distill = countingDistiller();

    const result = await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.undistilled).toBe(true);
    expect(result.swept[0]?.eventCount).toBe(3);
    expect(result.swept[0]?.records).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(distill.calls).toBe(0);
  });

  it('does not re-read an undistillable session on every sweep', async () => {
    const { adapter, registry } = setup({ capabilities: { canDistill: false } });
    const distill = countingDistiller();
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(registry, distill, options);
    await runSweep(registry, distill, options);

    expect(adapter.readSessionCalls).toHaveLength(1);
  });

  // Covers AE9.
  it('reports a failing session and leaves other sessions unaffected', async () => {
    const events = new Map([
      ['ses-bad', [eventAt(0, 'ses-bad')]],
      ['ses-good', [eventAt(0, 'ses-good')]],
    ]);
    const adapter = new FakeAdapter(
      'fake',
      [
        descriptor({ sessionId: 'ses-bad' }),
        descriptor({ sessionId: 'ses-good', lastModified: minutesAgo(45) }),
      ],
      events,
      {},
      'ses-bad',
    );
    const registry = new AdapterRegistry([adapter]);

    const result = await runSweep(registry, countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sessionId).toBe('ses-bad');
    expect(result.swept.map((s) => s.sessionId)).toEqual(['ses-good']);
  });

  it('never throws when the distiller itself fails', async () => {
    const { registry } = setup();
    const exploding: Distiller = async () => {
      throw new Error('model returned invalid JSON');
    };

    const result = await runSweep(registry, exploding, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.failures[0]?.reason).toContain('invalid JSON');
    expect(result.swept).toEqual([]);
  });

  it('retries a failed session rather than advancing past it', async () => {
    const { registry } = setup();
    const exploding: Distiller = async () => {
      throw new Error('transient');
    };
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(registry, exploding, options);
    const state = await loadState(cacheDir);

    expect(state.sessions['fake:ses-1']?.watermark).toBe(-1);
    expect(state.sessions['fake:ses-1']?.failureCount).toBe(1);
    expect(state.sessions['fake:ses-1']?.lastError).toContain('transient');
  });

  it('treats a distiller returning null as undistilled rather than failed', async () => {
    const { registry } = setup();
    const declines: Distiller = async () => null;

    const result = await runSweep(registry, declines, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.undistilled).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('caps work per invocation and reports what was deferred', async () => {
    const events = new Map<string, MemoryEvent[]>(
      ['a', 'b', 'c'].map((id) => [`ses-${id}`, [eventAt(0, `ses-${id}`)]]),
    );
    const adapter = new FakeAdapter(
      'fake',
      ['a', 'b', 'c'].map((id) => descriptor({ sessionId: `ses-${id}` })),
      events,
    );

    const result = await runSweep(new AdapterRegistry([adapter]), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      maxSessions: 2,
    });

    expect(result.swept).toHaveLength(2);
    expect(result.deferred).toBe(1);
  });

  it('skips every session when none has gone quiet', async () => {
    const events = new Map([['ses-1', [eventAt(0)]]]);
    const adapter = new FakeAdapter('fake', [descriptor({ lastModified: minutesAgo(2) })], events);

    const result = await runSweep(new AdapterRegistry([adapter]), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('still-active');
  });
});

describe('sweep state', () => {
  it('round-trips through disk', async () => {
    const state = emptyState();
    state.sessions['fake:ses-1'] = {
      sessionId: 'ses-1',
      adapter: 'fake',
      watermark: 7,
      lastSeenModified: minutesAgo(30),
      lastSweptAt: NOW.toISOString(),
      lastError: null,
      failureCount: 0,
    };

    await saveState(cacheDir, state);

    expect(await loadState(cacheDir)).toEqual(state);
  });

  it('falls back to empty state when the file is corrupt', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'sweep-state.json'), '{ not json', 'utf8');

    expect(await loadState(cacheDir)).toEqual(emptyState());
  });

  it('falls back to empty state when the file has an unexpected shape', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'sweep-state.json'), '{"version":99}', 'utf8');

    expect(await loadState(cacheDir)).toEqual(emptyState());
  });

  it('returns empty state when nothing has been written yet', async () => {
    expect(await loadState(join(cacheDir, 'fresh'))).toEqual(emptyState());
  });

  it('namespaces session ids by adapter so two agents cannot collide', () => {
    expect(stateKey('claude-code', 'abc')).not.toBe(stateKey('codex', 'abc'));
  });
});

describe('cache retention', () => {
  it('purges cached events past the retention window and keeps newer ones', async () => {
    const eventsDir = join(cacheDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const old = join(eventsDir, 'old.json');
    const recent = join(eventsDir, 'recent.json');
    await writeFile(old, '[]', 'utf8');
    await writeFile(recent, '[]', 'utf8');

    const longAgo = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);

    const result = await purgeCache(cacheDir, 30, NOW);

    expect(result.purged).toBe(1);
    expect(result.kept).toBe(1);
  });

  it('does nothing when there is no cache yet', async () => {
    expect(await purgeCache(join(cacheDir, 'absent'), 30, NOW)).toEqual({ purged: 0, kept: 0 });
  });
});

describe('a session where only part could be read', () => {
  function setup() {
    const events = new Map([['ses-1', [eventAt(0), eventAt(1), eventAt(2)]]]);
    return new AdapterRegistry([new FakeAdapter('fake', [descriptor()], events)]);
  }

  const partial = (failures: number): Distiller =>
    async () => markPartial([recordFor('ses-1', 'kept')], failures);

  it('keeps what was read', async () => {
    const result = await runSweep(setup(), partial(1), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.records).toHaveLength(1);
  });

  it('reports how much of it failed rather than passing silently', async () => {
    const result = await runSweep(setup(), partial(2), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(result.swept[0]?.partial).toBe(2);
  });

  it('leaves the watermark alone, so the failed region is read again', async () => {
    // Advancing past it skipped those events forever with nothing said. Record
    // IDs derive from content, so re-reading costs a pass and no duplicates.
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(setup(), partial(1), options);
    const after = await loadState(cacheDir);
    const key = Object.keys(after.sessions)[0]!;

    expect(after.sessions[key]?.watermark).toBe(-1);
  });

  it('advances normally when every region was read', async () => {
    const options = { cacheDir, quietWindowMinutes: 15, now: NOW };

    await runSweep(setup(), async () => [recordFor('ses-1', 'a')], options);
    const after = await loadState(cacheDir);
    const key = Object.keys(after.sessions)[0]!;

    expect(after.sessions[key]?.watermark).toBe(2);
  });
});


describe('saying what it is doing while it does it', () => {
  function twoSessions() {
    const events = new Map([
      ['ses-1', [eventAt(0, 'ses-1'), eventAt(1, 'ses-1')]],
      ['ses-2', [eventAt(0, 'ses-2')]],
    ]);

    return new AdapterRegistry([
      new FakeAdapter(
        'fake',
        [descriptor(), descriptor({ sessionId: 'ses-2', sessionFile: '/tmp/ses-2.jsonl' })],
        events,
      ),
    ]);
  }

  async function sweepReporting(
    registry: AdapterRegistry,
    distill: Distiller,
    options: { maxSessions?: number } = {},
  ): Promise<SweepProgress[]> {
    const seen: SweepProgress[] = [];
    await runSweep(registry, distill, {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onProgress: (event) => seen.push(event),
      ...options,
    });
    return seen;
  }

  // A first sync over an established repository is tens of minutes of model
  // calls. Without a count there is no way to tell it from a hang.
  it('says how much there is to do before it starts doing it', async () => {
    const seen = await sweepReporting(twoSessions(), countingDistiller());

    expect(seen[0]).toEqual({ phase: 'planned', discovered: 2, eligible: 2, deferred: 0 });
  });

  it('counts each session against the total as it goes', async () => {
    const seen = await sweepReporting(twoSessions(), countingDistiller());

    const done = seen.filter((event) => event.phase === 'done');
    expect(done.map((event) => `${event.index}/${event.total}`)).toEqual(['1/2', '2/2']);
  });

  it('reports the sessions a cap left for the next run', async () => {
    const seen = await sweepReporting(twoSessions(), countingDistiller(), { maxSessions: 1 });

    expect(seen[0]).toMatchObject({ eligible: 2, deferred: 1 });
    expect(seen.filter((event) => event.phase === 'done')).toHaveLength(1);
  });

  it('says how many events a session has, since that is what the wait scales with', async () => {
    const seen = await sweepReporting(twoSessions(), countingDistiller());

    expect(seen.find((event) => event.phase === 'distilling')).toMatchObject({
      sessionId: 'ses-1',
      events: 2,
    });
  });

  // The distiller is built once and reused, so it cannot name the session
  // itself. The sweep hands it a channel that already knows.
  it('carries a note from inside the distiller under the right session', async () => {
    const chatty: Distiller = async ({ onProgress }) => {
      onProgress?.('chunk 1 of 3');
      return [];
    };

    const seen = await sweepReporting(twoSessions(), chatty);

    expect(seen.find((event) => event.phase === 'note')).toMatchObject({
      sessionId: 'ses-1',
      index: 1,
      total: 2,
      message: 'chunk 1 of 3',
    });
  });

  it('reports a failed session with the reason rather than only a count', async () => {
    const events = new Map([['ses-1', [eventAt(0)]]]);
    const registry = new AdapterRegistry([
      new FakeAdapter('fake', [descriptor()], events, {}, 'ses-1'),
    ]);

    const seen = await sweepReporting(registry, countingDistiller());

    expect(seen.at(-1)).toMatchObject({
      phase: 'done',
      outcome: 'failed',
      reason: 'session file vanished',
    });
  });

  it('reports a session that could only be read in part', async () => {
    const events = new Map([['ses-1', [eventAt(0)]]]);
    const registry = new AdapterRegistry([new FakeAdapter('fake', [descriptor()], events)]);

    const seen = await sweepReporting(
      registry,
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['claude-code: timed out']),
    );

    expect(seen.at(-1)).toMatchObject({ phase: 'done', outcome: 'partial' });
  });
});

describe('why part of a session could not be read', () => {
  it('carries the reason alongside the count', async () => {
    const events = new Map([['ses-1', [eventAt(0)]]]);
    const registry = new AdapterRegistry([new FakeAdapter('fake', [descriptor()], events)]);

    const result = await runSweep(
      registry,
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['claude-code: timed out after 300000ms']),
      { cacheDir, quietWindowMinutes: 15, now: NOW },
    );

    expect(result.swept[0]?.partialReasons).toEqual(['claude-code: timed out after 300000ms']);
  });

  // A count alone said something went wrong and nothing about what.
  it('reads a mark that carries no reasons as no reasons rather than as complete', () => {
    expect(partialReasons(markPartial([], 2))).toEqual([]);
    expect(partialFailures(markPartial([], 2))).toBe(2);
  });
});


describe('keeping what a long sweep has already earned', () => {
  function twoSessions() {
    const events = new Map([
      ['ses-1', [eventAt(0, 'ses-1'), eventAt(1, 'ses-1')]],
      ['ses-2', [eventAt(0, 'ses-2')]],
    ]);

    return new AdapterRegistry([
      new FakeAdapter(
        'fake',
        [descriptor(), descriptor({ sessionId: 'ses-2', sessionFile: '/tmp/ses-2.jsonl' })],
        events,
      ),
    ]);
  }

  it('hands over each session as it finishes rather than all of them at the end', async () => {
    const handed: Array<{ sessionId: string; records: number }> = [];

    await runSweep(twoSessions(), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onSession: (session) =>
        void handed.push({ sessionId: session.sessionId, records: session.records.length }),
    });

    expect(handed).toEqual([
      { sessionId: 'ses-1', records: 2 },
      { sessionId: 'ses-2', records: 1 },
    ]);
  });

  // A sweep of a backlog runs for tens of minutes and gets interrupted. Saving
  // only at the end threw away every session it had already paid for.
  it('writes the watermark for a finished session before starting the next', async () => {
    const watermarksSeenDuringSecond: Array<number | undefined> = [];

    await runSweep(twoSessions(), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onSession: async (session) => {
        if (session.sessionId !== 'ses-2') return;
        const onDisk = await loadState(cacheDir);
        watermarksSeenDuringSecond.push(onDisk.sessions[stateKey('fake', 'ses-1')]?.watermark);
      },
    });

    expect(watermarksSeenDuringSecond).toEqual([1]);
  });

  // Saving is what makes a session done. Counting it as swept when the records
  // never reached disk would advance the watermark past events nobody kept.
  it('treats a session whose records could not be saved as failed', async () => {
    const result = await runSweep(twoSessions(), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onSession: (session) => {
        if (session.sessionId === 'ses-1') throw new Error('index is locked');
      },
    });

    expect(result.failures).toEqual([
      { sessionId: 'ses-1', adapter: 'fake', reason: 'index is locked' },
    ]);
    expect(result.swept.map((session) => session.sessionId)).toEqual(['ses-2']);
  });

  it('leaves that session\'s watermark alone, so it is read again', async () => {
    await runSweep(twoSessions(), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onSession: (session) => {
        if (session.sessionId === 'ses-1') throw new Error('index is locked');
      },
    });

    const state = await loadState(cacheDir);
    expect(state.sessions[stateKey('fake', 'ses-1')]?.watermark).toBe(-1);
    expect(state.sessions[stateKey('fake', 'ses-2')]?.watermark).toBe(0);
  });

  it('keeps the sessions that did work when a later one fails', async () => {
    const saved: string[] = [];

    const result = await runSweep(twoSessions(), countingDistiller(), {
      cacheDir,
      quietWindowMinutes: 15,
      now: NOW,
      onSession: (session) => {
        if (session.sessionId === 'ses-2') throw new Error('disk full');
        saved.push(session.sessionId);
      },
    });

    expect(saved).toEqual(['ses-1']);
    expect(result.swept.map((session) => session.sessionId)).toEqual(['ses-1']);
  });
});

describe('resuming a session that was interrupted part way', () => {
  /*
   * One failed call out of fifteen used to cost the other fourteen again. The
   * watermark stayed put, so the next sweep re-read the whole session and paid
   * for every chunk. Measured on a 2687-event session: 93k input tokens
   * re-spent to redo work already done, on every sweep.
   */
  function oneSession() {
    const events = new Map([['ses-1', [eventAt(0, 'ses-1'), eventAt(1, 'ses-1'), eventAt(2, 'ses-1')]]]);
    return new AdapterRegistry([new FakeAdapter('fake', [descriptor()], events)]);
  }

  it('keeps the ground the successful calls gained', async () => {
    await runSweep(
      oneSession(),
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['timed out'], 1),
      { cacheDir, quietWindowMinutes: 15, now: NOW },
    );

    const state = await loadState(cacheDir);
    expect(state.sessions[stateKey('fake', 'ses-1')]?.watermark).toBe(1);
  });

  // Eligibility skips a session whose file has not changed since a sweep that
  // advanced the watermark. Recording the current mtime here would advance the
  // watermark and then refuse to look again, abandoning the part that failed.
  it('stays eligible, so the part that failed is actually retried', async () => {
    const registry = oneSession();

    await runSweep(
      registry,
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['timed out'], 1),
      { cacheDir, quietWindowMinutes: 15, now: NOW },
    );

    const state = await loadState(cacheDir);
    const assessment = assessEligibility(descriptor(), state, {
      quietWindowMinutes: 15,
      now: NOW,
    });

    expect(assessment.eligible).toBe(true);
  });

  it('reads only what is left the next time round', async () => {
    const registry = oneSession();
    const adapter = registry.all()[0] as unknown as { readSessionCalls: Array<{ fromOffset: number | undefined }> };

    const partial: Distiller = async () => markPartial([recordFor('ses-1', 'kept')], 1, ['timed out'], 1);

    await runSweep(registry, partial, { cacheDir, quietWindowMinutes: 15, now: NOW });
    await runSweep(registry, partial, { cacheDir, quietWindowMinutes: 15, now: NOW });

    expect(adapter.readSessionCalls.map((call) => call.fromOffset)).toEqual([-1, 1]);
  });

  // Chunks are ordered by offset, so once one fails nothing after it counts as
  // covered however well it went.
  it('does not credit progress past the first failure', async () => {
    await runSweep(
      oneSession(),
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['timed out']),
      { cacheDir, quietWindowMinutes: 15, now: NOW },
    );

    const state = await loadState(cacheDir);
    expect(state.sessions[stateKey('fake', 'ses-1')]?.watermark).toBe(-1);
  });

  it('never moves the watermark backwards', async () => {
    const registry = oneSession();

    await saveState(cacheDir, {
      version: 1,
      sessions: {
        [stateKey('fake', 'ses-1')]: {
          sessionId: 'ses-1',
          adapter: 'fake',
          watermark: 2,
          lastSeenModified: 'old',
          lastSweptAt: NOW.toISOString(),
          lastError: null,
          failureCount: 0,
        },
      },
    });

    await runSweep(
      registry,
      async () => markPartial([recordFor('ses-1', 'kept')], 1, ['timed out'], 0),
      { cacheDir, quietWindowMinutes: 15, now: NOW },
    );

    const state = await loadState(cacheDir);
    expect(state.sessions[stateKey('fake', 'ses-1')]?.watermark).toBe(2);
  });
});
