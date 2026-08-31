import { describe, expect, it } from 'vitest';
import type { MemoryEvent, SessionDescriptor } from '@trackway/core';
import {
  EXTRACTION_MARKER,
  RunnerError,
  buildPrompt,
  collectText,
  createDistiller,
  createRunnerChain,
  defaultRunners,
  distillEnv,
  insideDistillation,
  isFatal,
  isOwnExtraction,
  runnerWorkingDir,
  type DistillRunner,
} from '../src/index.js';

function eventAt(offset: number, type: MemoryEvent['type'], payload: unknown): MemoryEvent {
  return {
    id: `claude-code:ses-1:${offset}`,
    sessionId: 'ses-1',
    timestamp: '2026-08-31T09:00:00Z',
    type,
    actor: type === 'user_prompt' ? { type: 'human', id: 'human:local' } : { type: 'agent', id: 'agent:claude-code' },
    payload,
    source: { adapter: 'claude-code', sessionFile: '/tmp/ses-1.jsonl', offset },
  };
}

function stub(id: string, behaviour: () => Promise<string>): DistillRunner {
  return { id, isAvailable: async () => ({ available: true }), run: behaviour };
}

describe('refusing to distil our own distillation', () => {
  /*
   * A sweep distils by starting an agent session, and the agent records that
   * session like any other. Those were then discovered and distilled, which
   * started more of them. On this repository 143 of 151 discovered sessions
   * were Trackway's own calls.
   */
  it('recognises a session that is one of our extraction calls', () => {
    const events = [
      eventAt(0, 'user_prompt', { content: buildPrompt({ events: [], adapterId: 'claude-code' }) }),
      eventAt(1, 'agent_message', { content: [{ type: 'text', text: '{}' }] }),
    ];

    expect(isOwnExtraction(events)).toBe(true);
  });

  // The payload is adapter-shaped. Reading `payload.text` matched none of 151
  // real sessions, because Claude Code calls the field `content`.
  it('finds the prompt wherever the adapter put it', () => {
    expect(isOwnExtraction([eventAt(0, 'user_prompt', { content: EXTRACTION_MARKER })])).toBe(true);
    expect(isOwnExtraction([eventAt(0, 'user_prompt', { text: EXTRACTION_MARKER })])).toBe(true);
    expect(
      isOwnExtraction([eventAt(0, 'user_prompt', { content: [{ type: 'text', text: EXTRACTION_MARKER }] })]),
    ).toBe(true);
  });

  it('leaves real work alone', () => {
    const events = [
      eventAt(0, 'user_prompt', { content: 'Why is the cache invalidating on every write?' }),
      eventAt(1, 'agent_message', { content: [{ type: 'text', text: 'Because the key includes a timestamp.' }] }),
    ];

    expect(isOwnExtraction(events)).toBe(false);
  });

  // The marker has to survive the prompt being edited, so it is derived from
  // the prompt rather than copied out of it.
  it('takes its marker from the prompt itself', () => {
    expect(buildPrompt({ events: [], adapterId: 'claude-code' })).toContain(EXTRACTION_MARKER);
  });
});

describe('not starting a sweep from inside a sweep', () => {
  /*
   * The agent runs the developer's hooks when a session ends, and the hook
   * Trackway installs starts a sweep. The sweep's own subprocess therefore
   * fired the hook that starts a sweep. Thirty-nine concurrent syncs appeared
   * on a real machine within a few minutes.
   */
  it('marks the subprocess environment', () => {
    expect(distillEnv({ PATH: '/usr/bin' })).toMatchObject({
      PATH: '/usr/bin',
      TRACKWAY_DISTILLING: '1',
    });
  });

  it('recognises the mark', () => {
    expect(insideDistillation({ TRACKWAY_DISTILLING: '1' })).toBe(true);
    expect(insideDistillation({})).toBe(false);
  });

  it('runs subprocesses outside any repository', () => {
    // Claude Code records the working directory, and Trackway matches sessions
    // to a repository by exactly that. Run from the repository and every call
    // produces a session the next sweep picks up.
    expect(runnerWorkingDir('/home/dev')).toBe('/home/dev/.trackway/runner');
  });
});

describe('falling back to whichever agent this machine has', () => {
  it('uses the first runner that works', async () => {
    const chain = createRunnerChain([
      stub('claude-code', async () => 'from claude'),
      stub('codex', async () => 'from codex'),
    ]);

    expect(await chain.run('prompt')).toBe('from claude');
  });

  it('moves on when a runner is not installed', async () => {
    const chain = createRunnerChain([
      stub('claude-code', async () => {
        throw new RunnerError('claude-code', 'unavailable', 'could not start claude');
      }),
      stub('codex', async () => 'from codex'),
    ]);

    expect(await chain.run('prompt')).toBe('from codex');
  });

  /*
   * A runner can pass an availability check and still fail every call: `codex
   * exec` printed its version happily and then returned 402 Payment Required
   * with `deactivated_workspace` on a real machine.
   */
  it('treats an account failure as fatal, not as something to retry', () => {
    const dead = new RunnerError('codex', 'exit', 'exited with code 1: unexpected status 402 Payment Required');
    const stalled = new RunnerError('claude-code', 'timeout', 'timed out after 300000ms');

    expect(isFatal(dead)).toBe(true);
    expect(isFatal(stalled)).toBe(false);
  });

  it('falls through an account failure to the next agent', async () => {
    const chain = createRunnerChain([
      stub('codex', async () => {
        throw new RunnerError('codex', 'exit', 'exited with code 1: 402 Payment Required');
      }),
      stub('opencode', async () => 'from opencode'),
    ]);

    expect(await chain.run('prompt')).toBe('from opencode');
  });

  it('stops asking a runner that already proved dead', async () => {
    let asked = 0;
    const chain = createRunnerChain([
      stub('codex', async () => {
        asked += 1;
        throw new RunnerError('codex', 'exit', 'exited with code 1: 401 unauthorized');
      }),
      stub('opencode', async () => 'from opencode'),
    ]);

    await chain.run('one');
    await chain.run('two');
    await chain.run('three');

    expect(asked).toBe(1);
  });

  // A timeout is circumstance. Handing it to the next agent would spend a
  // second full call on something the caller is about to retry anyway.
  it('lets a transient failure reach the caller instead of switching agent', async () => {
    let secondAsked = false;
    const chain = createRunnerChain([
      stub('claude-code', async () => {
        throw new RunnerError('claude-code', 'timeout', 'timed out');
      }),
      stub('codex', async () => {
        secondAsked = true;
        return 'from codex';
      }),
    ]);

    await expect(chain.run('prompt')).rejects.toThrow(RunnerError);
    expect(secondAsked).toBe(false);
  });

  it('offers every shipped agent, Claude first because its call is cheapest', () => {
    expect(defaultRunners().map((runner) => runner.id)).toEqual(['claude-code', 'codex', 'opencode']);
  });
});

describe('reading an OpenCode run back', () => {
  it('joins the text parts and ignores the lifecycle around them', () => {
    const stream = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '{"decisions":' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '[]}' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
    ].join('\n');

    expect(collectText(stream)).toBe('{"decisions":[]}');
  });

  // OpenCode's event vocabulary is internal, not a published contract, so an
  // unfamiliar line should cost nothing.
  it('skips a line it cannot parse rather than refusing the run', () => {
    expect(collectText('not json\n' + JSON.stringify({ type: 'text', part: { text: 'ok' } }))).toBe('ok');
  });
});

describe('telling a deliberate skip from an agent that cannot distil', () => {
  // Reporting our own exhaust as "this agent cannot distil" told the reader
  // the wrong thing about 143 of 151 sessions.
  it('carries the reason a session was declined', async () => {
    const { markSkipped, skippedReason } = await import('../src/index.js');

    expect(skippedReason(markSkipped('one of our own distillation calls'))).toBe(
      'one of our own distillation calls',
    );
    expect(skippedReason([])).toBeUndefined();
    expect(skippedReason(null)).toBeUndefined();
  });
});

describe('sizing a chunk by how big the request will be', () => {
  const sizeOf = (event: MemoryEvent): number => String((event.payload as { content?: string }).content ?? '').length;

  function sized(lengths: number[]): MemoryEvent[] {
    return lengths.map((n, i) => eventAt(i, 'user_prompt', { content: 'x'.repeat(n) }));
  }

  /*
   * Count is the wrong unit and using it caused real timeouts: a 2687-event
   * session widened to 224 events per chunk produced a first request of 91k
   * characters, which timed out at 300 seconds twice while an equivalent 41k
   * request had been measured at 54 seconds.
   */
  it('breaks a chunk when the request would get too large', async () => {
    const { chunkEvents } = await import('../src/index.js');

    const chunks = chunkEvents(sized([400, 400, 400, 400]), {
      chunkSize: 100,
      maxChars: 1000,
      sizeOf,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.events).toHaveLength(2);
  });

  it('still breaks on count, so a chunk stays one readable conversation', async () => {
    const { chunkEvents } = await import('../src/index.js');

    const chunks = chunkEvents(sized([1, 1, 1, 1, 1]), { chunkSize: 2, maxChars: 10_000, sizeOf });

    expect(chunks.map((chunk) => chunk.events.length)).toEqual([2, 2, 1]);
  });

  // Losing an event is worse than one larger request, and the renderer already
  // truncates each event, so an oversized one is bounded anyway.
  it('keeps an event that is bigger than the whole budget', async () => {
    const { chunkEvents } = await import('../src/index.js');

    const chunks = chunkEvents(sized([50, 5000, 50]), { chunkSize: 100, maxChars: 1000, sizeOf });

    expect(chunks.flatMap((chunk) => chunk.events)).toHaveLength(3);
  });

  it('covers every event, which is the point of chunking at all', async () => {
    const { chunkEvents } = await import('../src/index.js');

    const events = sized(Array.from({ length: 300 }, (_, i) => 100 + (i % 7) * 300));
    const chunks = chunkEvents(events, { chunkSize: 120, maxChars: 4000, sizeOf });

    const covered = new Set(chunks.flatMap((c) => c.events.map((e) => e.source.offset)));
    expect(covered.size).toBe(300);
    expect(chunks.every((c) => c.total === chunks.length)).toBe(true);
  });

  it('bounds by count alone when no size budget is given, as before', async () => {
    const { chunkEvents } = await import('../src/index.js');

    expect(chunkEvents(sized(Array(250).fill(10)), { chunkSize: 120 })).toHaveLength(3);
  });
});

describe('what a sync spends', () => {
  const descriptor: SessionDescriptor = {
    sessionId: 'ses-1',
    adapter: 'claude-code',
    sessionFile: '/tmp/ses-1.jsonl',
    cwd: '/repo',
    branch: 'main',
    lastModified: '2026-08-31T09:00:00Z',
    formatVersion: 'claude-code/jsonl-v1',
  };

  const empty = JSON.stringify({ questions: [], discoveries: [], decisions: [], actions: [], outcomes: [] });

  function chatty(n: number): MemoryEvent[] {
    return Array.from({ length: n }, (_, i) =>
      eventAt(i, i % 2 === 0 ? 'user_prompt' : 'agent_message', { content: 'x'.repeat(3000) }),
    );
  }

  /*
   * Thinking was 95% of what a call emitted: 5380 thinking tokens to produce
   * 958 characters of JSON, and output is priced far above input. Judged by a
   * stronger model on a real session, turning it off cost a third as much,
   * found 8 sound decisions instead of 5, and moved precision 0.83 to 0.80.
   */
  it('asks the agent not to think, because extraction is transcription', async () => {
    const { DISTILL_SETTINGS } = await import('../src/index.js');
    expect(DISTILL_SETTINGS).toContain('alwaysThinkingEnabled');
    expect(DISTILL_SETTINGS).toContain('false');
  });

  it('reports what each call consumed instead of discarding it', async () => {
    const seen: number[] = [];
    const runner: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async (_prompt, options) => {
        options?.onUsage?.({ inputTokens: 100, cachedTokens: 10, outputTokens: 20, costUsd: 0.5 });
        return empty;
      },
    };

    await createDistiller({ runner, chunkSize: 10, onUsage: (u) => seen.push(u.costUsd) })({
      descriptor,
      events: chatty(20),
      fromOffset: -1,
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((cost) => cost === 0.5)).toBe(true);
  });

  /*
   * Bounding sessions let one firing of the hook spend forty-five calls on
   * three long ones. Calls are the unit that costs money, so calls are what a
   * background sweep is bounded by.
   */
  it('stops when the run is out of calls', async () => {
    let calls = 0;
    const runner: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async () => {
        calls += 1;
        return empty;
      },
    };

    await createDistiller({ runner, chunkSize: 10, callBudget: { remaining: 2 } })({
      descriptor,
      events: chatty(100),
      fromOffset: -1,
    });

    expect(calls).toBe(2);
  });

  // Running out is not a failure, so it must not count against the session.
  it('records how far it got so the next run continues', async () => {
    const { incompleteCoveredTo } = await import('../src/index.js');
    const runner: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async () => empty,
    };

    const records = await createDistiller({ runner, chunkSize: 10, callBudget: { remaining: 2 } })({
      descriptor,
      events: chatty(100),
      fromOffset: -1,
    });

    expect(incompleteCoveredTo(records)).toBe(19);
  });

  // Nobody decides anything in a stretch of pure tool traffic, and asking costs
  // a call to be told so.
  it('does not spend a call on a chunk that is only tool traffic', async () => {
    let calls = 0;
    const runner: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async () => {
        calls += 1;
        return empty;
      },
    };

    const toolsOnly = Array.from({ length: 20 }, (_, i) =>
      eventAt(i, i % 2 === 0 ? 'tool_call' : 'tool_result', { content: 'ls -la' }),
    );

    await createDistiller({ runner, chunkSize: 10 })({ descriptor, events: toolsOnly, fromOffset: -1 });

    expect(calls).toBe(0);
  });

  it('still sends a chunk where somebody said something', async () => {
    let calls = 0;
    const runner: DistillRunner = {
      id: 'stub',
      isAvailable: async () => ({ available: true }),
      run: async () => {
        calls += 1;
        return empty;
      },
    };

    const mixed = [
      eventAt(0, 'user_prompt', { content: 'Why is the cache cold?' }),
      ...Array.from({ length: 9 }, (_, i) => eventAt(i + 1, 'tool_result', { content: 'ok' })),
    ];

    await createDistiller({ runner, chunkSize: 10 })({ descriptor, events: mixed, fromOffset: -1 });

    expect(calls).toBe(1);
  });
});

describe('stopping cleanly when the budget is gone', () => {
  // A spent budget used to still open, read and report on every remaining
  // session to reach the same answer: not this run.
  it('does not even look at sessions it cannot afford', async () => {
    const { AdapterRegistry } = await import('@trackway/adapters');
    const { runSweep } = await import('../src/index.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const cacheDir = await mkdtemp(join(tmpdir(), 'trackway-budget-'));
    const reads: string[] = [];

    const describe1 = (id: string) => ({
      sessionId: id,
      adapter: 'fake',
      sessionFile: `/tmp/${id}.jsonl`,
      cwd: '/repo',
      branch: 'main',
      lastModified: '2026-08-31T09:00:00Z',
      formatVersion: 'fake-v1',
    });

    const adapter = {
      id: 'fake',
      capabilities: { canDistill: true, suppliesRedaction: false, supportsHook: false },
      isAvailable: async () => ({ available: true }),
      listSessions: async () => [describe1('a'), describe1('b'), describe1('c')],
      readSession: async (d: { sessionId: string }) => {
        reads.push(d.sessionId);
        return [eventAt(0, 'user_prompt', { content: 'hello' })];
      },
    };

    let budget = 1;
    const result = await runSweep(
      new AdapterRegistry([adapter as never]),
      async () => {
        budget -= 1;
        return [];
      },
      {
        cacheDir,
        quietWindowMinutes: 0,
        now: new Date('2026-08-31T12:00:00Z'),
        hasBudget: () => budget > 0,
      },
    );

    expect(reads).toEqual(['a']);
    expect(result.deferred).toBe(2);
  });
});
