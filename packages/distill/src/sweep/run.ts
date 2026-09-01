import type { AdapterRegistry, SessionAdapter } from '@trackway/adapters';
import type { MemoryEvent, MemoryRecord, SessionDescriptor } from '@trackway/core';
import { assessEligibility, type SkipReason } from './quiet.js';
import { loadState, saveState, stateKey, type SweepState } from './state.js';

export interface SweepOptions {
  cacheDir: string;
  quietWindowMinutes: number;
  repoRoot?: string;
  now?: Date;
  /** Caps work per invocation so a first run over a large backlog stays responsive. */
  maxSessions?: number;
  /**
   * Called as the sweep advances.
   *
   * A first sync over an established repository is minutes of model calls, and
   * without this it is minutes of a cursor sitting on an empty line. There is
   * no way for the person watching to tell that apart from a hang, so they kill
   * it, and the work is lost.
   */
  onProgress?: (event: SweepProgress) => void;
  /**
   * Saves one session's records before the next one is started.
   *
   * A sweep over an established repository runs for tens of minutes. Holding
   * every record until the last session finished meant a sweep that was
   * interrupted, or that fell over on session nine of twelve, kept nothing at
   * all and started from the beginning next time. Throwing from here marks the
   * session failed, so its watermark stays put and it is read again rather than
   * being counted as done with nothing written.
   */
  onSession?: (session: SweptSession) => Promise<void> | void;
  /**
   * Whether there is still budget to spend.
   *
   * Asked before each session rather than discovered inside one. Without it a
   * spent budget still opened, read and reported on every remaining session,
   * which is a pile of file reads and a confusing summary to reach the same
   * answer: not this run.
   */
  hasBudget?: () => boolean;
}

/**
 * What the sweep is doing, in a shape the caller can render however it likes.
 *
 * Structured rather than pre-formatted strings, because the counts are the
 * point: a terminal wants to overwrite one line with "3 of 12", a log file
 * wants a line each, and neither should have to parse prose to get there.
 */
export type SweepProgress =
  /** Discovery finished. Everything after this is bounded by `eligible`. */
  | { phase: 'planned'; discovered: number; eligible: number; deferred: number }
  /** A session is about to be read from disk. */
  | { phase: 'reading'; index: number; total: number; sessionId: string; adapter: string }
  /** The session was read, and distillation is starting on this many events. */
  | { phase: 'distilling'; index: number; total: number; sessionId: string; events: number }
  /** Progress from inside the distiller, which knows about chunks and retries. */
  | { phase: 'note'; index: number; total: number; sessionId: string; message: string }
  /** A session finished, one way or another. */
  | {
      phase: 'done';
      index: number;
      total: number;
      sessionId: string;
      records: number;
      outcome: 'distilled' | 'ingest-only' | 'partial' | 'failed' | 'skipped';
      reason?: string;
    };

/**
 * Turns a quiet session's new events into records.
 *
 * Supplied by the caller rather than imported, so the sweep can be tested
 * without invoking a model, and so an adapter that cannot distil can be handled
 * by returning null.
 */
export type Distiller = (input: {
  descriptor: SessionDescriptor;
  events: MemoryEvent[];
  fromOffset: number;
  /**
   * Where to send progress for this session.
   *
   * Per call rather than per distiller, because the distiller is built once and
   * reused across sessions while the sweep knows which session is in hand.
   */
  onProgress?: (message: string) => void;
}) => Promise<MemoryRecord[] | null>;

/**
 * Marks records that came from a session where some region could not be read.
 *
 * A session distilled in several calls can have one of them fail after retries
 * while the rest succeed. Those records are worth keeping, but the watermark
 * must not move past the part that failed, or those events are skipped forever
 * and nothing ever says so. Record IDs derive from content, so re-reading the
 * region on the next sweep costs a second pass and creates no duplicates.
 */
export const PARTIAL = Symbol.for('trackway.partialDistillation');

interface PartialMark {
  count: number;
  reasons: string[];
  /**
   * Highest offset covered by an unbroken run of successful calls.
   *
   * Without it, one failed call out of fifteen threw away the other fourteen:
   * the watermark stayed where it was, so the next sweep re-read the whole
   * session and paid for every chunk again. Measured on a 2687-event session,
   * that was 93k input tokens re-spent to redo work already done, every sweep,
   * until the session either succeeded outright or was given up on.
   *
   * Only an unbroken run counts. Chunks are ordered by offset, so if the third
   * failed, nothing after it can be trusted as covered even though it
   * succeeded, and re-reading from the third costs one pass and no duplicates.
   */
  coveredTo?: number;
}

export function markPartial(
  records: MemoryRecord[],
  failures: number,
  reasons: readonly string[] = [],
  coveredTo?: number,
): MemoryRecord[] {
  return Object.defineProperty(records, PARTIAL, {
    value: {
      count: failures,
      reasons: [...reasons],
      ...(coveredTo === undefined ? {} : { coveredTo }),
    } satisfies PartialMark,
    enumerable: false,
  }) as MemoryRecord[];
}

function partialMark(records: MemoryRecord[] | null): PartialMark | undefined {
  const value = records === null ? undefined : (records as unknown as Record<symbol, unknown>)[PARTIAL];
  // Older marks carried the count alone. Reading both costs nothing and keeps
  // a records array built by anything else from being misread as complete.
  if (typeof value === 'number') return { count: value, reasons: [] };
  if (value && typeof value === 'object' && typeof (value as PartialMark).count === 'number') {
    return value as PartialMark;
  }
  return undefined;
}

export function partialFailures(records: MemoryRecord[] | null): number {
  return partialMark(records)?.count ?? 0;
}

/** Why the regions that failed failed, for reporting rather than for logic. */
export function partialReasons(records: MemoryRecord[] | null): string[] {
  return partialMark(records)?.reasons ?? [];
}

/** How far an interrupted session got, so the next sweep resumes rather than restarts. */
export function partialCoveredTo(records: MemoryRecord[] | null): number | undefined {
  return partialMark(records)?.coveredTo;
}

/**
 * Marks records from a session the distiller deliberately declined to send.
 *
 * Distinct from an adapter that cannot distil, which is what returning null
 * means. Reporting a skip as "this agent cannot distil" told the reader the
 * wrong thing about 143 of 151 sessions.
 */
export const SKIPPED = Symbol.for('trackway.skippedSession');

export function markSkipped(reason: string): MemoryRecord[] {
  return Object.defineProperty([] as MemoryRecord[], SKIPPED, {
    value: reason,
    enumerable: false,
  }) as MemoryRecord[];
}

export function skippedReason(records: MemoryRecord[] | null): string | undefined {
  const value = records === null ? undefined : (records as unknown as Record<symbol, unknown>)[SKIPPED];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Marks a session that stopped early because the sweep ran out of budget.
 *
 * Distinct from a partial failure. Nothing went wrong, so nothing should be
 * counted against the session, but the watermark must still advance only as far
 * as the work that was done.
 */
export const INCOMPLETE = Symbol.for('trackway.incompleteSession');

export function markIncomplete(records: MemoryRecord[], coveredTo: number | undefined): MemoryRecord[] {
  return Object.defineProperty(records, INCOMPLETE, {
    value: { coveredTo },
    enumerable: false,
  }) as MemoryRecord[];
}

export function incompleteCoveredTo(records: MemoryRecord[] | null): number | undefined | false {
  const value = records === null ? undefined : (records as unknown as Record<symbol, unknown>)[INCOMPLETE];
  if (value && typeof value === 'object') return (value as { coveredTo?: number }).coveredTo;
  return false;
}

export interface SweptSession {
  sessionId: string;
  adapter: string;
  records: MemoryRecord[];
  eventCount: number;
  /** True when the adapter cannot distil, so events were read but not turned into records. */
  undistilled: boolean;
  /** How many regions failed after retries. Their events are retried next sweep. */
  partial?: number;
  /** Why those regions failed. A count alone cannot be acted on. */
  partialReasons?: string[];
  /** Set when the distiller declined to send this session, and why. */
  skipped?: string;
  /** True when the sweep ran out of budget part way through this session. */
  incomplete?: boolean;
}

export interface SweepFailure {
  sessionId: string;
  adapter: string;
  reason: string;
}

export interface SweepResult {
  swept: SweptSession[];
  skipped: Array<{ sessionId: string; adapter: string; reason: SkipReason }>;
  failures: SweepFailure[];
  /** Sessions eligible but not reached because the per-run cap was hit. */
  deferred: number;
}

/**
 * One pass over every available adapter.
 *
 * Nothing here throws. A sweep runs from a CLI command and, later, from an
 * agent hook; in both cases a failure must be reported rather than raised,
 * because interrupting the developer's coding session is the one outcome this
 * system must never cause.
 */
export async function runSweep(
  registry: AdapterRegistry,
  distill: Distiller,
  options: SweepOptions,
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const state = await loadState(options.cacheDir);

  const result: SweepResult = { swept: [], skipped: [], failures: [], deferred: 0 };

  const discovered = await registry.listAllSessions(
    options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot },
  );

  const eligible: Array<{ descriptor: SessionDescriptor; adapter: SessionAdapter }> = [];

  for (const { descriptor, adapter } of discovered) {
    const assessment = assessEligibility(descriptor, state, {
      quietWindowMinutes: options.quietWindowMinutes,
      now,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    });

    if (assessment.eligible) {
      eligible.push({ descriptor, adapter });
    } else {
      result.skipped.push({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        reason: assessment.reason ?? 'already-distilled',
      });
    }
  }

  const cap = options.maxSessions ?? eligible.length;
  const batch = eligible.slice(0, cap);
  result.deferred = eligible.length - batch.length;

  const report = options.onProgress ?? (() => {});
  const total = batch.length;

  /**
   * Hands one finished session to the caller, then keeps it.
   *
   * Ordered this way on purpose: if saving throws, the exception reaches the
   * per-session catch below, the watermark stays where it was, and the session
   * is read again next sweep. Recording it as swept first would report work
   * that is not on disk.
   */
  const keep = async (session: SweptSession): Promise<void> => {
    await options.onSession?.(session);
    result.swept.push(session);
  };

  /**
   * Writes the watermarks earned so far.
   *
   * After every session rather than once at the end. A sweep of a large
   * backlog runs for tens of minutes and gets interrupted; saving only at the
   * end threw away every session it had already paid for.
   */
  const checkpoint = async (): Promise<void> => {
    await saveState(options.cacheDir, state).catch(() => {
      // A state write failure costs re-distillation next run, not correctness.
    });
  };

  report({
    phase: 'planned',
    discovered: discovered.length,
    eligible: eligible.length,
    deferred: result.deferred,
  });

  for (const [position, { descriptor, adapter }] of batch.entries()) {
    const key = stateKey(descriptor.adapter, descriptor.sessionId);
    const previous = state.sessions[key];
    const fromOffset = previous?.watermark ?? -1;
    const index = position + 1;
    const where = { index, total, sessionId: descriptor.sessionId } as const;

    if (options.hasBudget && !options.hasBudget()) {
      // Everything from here is for the next run, and saying so is more honest
      // than reporting each one as unfinished.
      result.deferred += total - position;
      break;
    }

    report({ phase: 'reading', ...where, adapter: descriptor.adapter });

    try {
      const events = await adapter.readSession(descriptor, { fromOffset });

      if (events.length === 0) {
        report({ phase: 'done', ...where, records: 0, outcome: 'distilled' });
        recordSuccess(state, key, descriptor, fromOffset, now);
        await checkpoint();
        continue;
      }

      report({ phase: 'distilling', ...where, events: events.length });

      const highestOffset = events.reduce(
        (max, event) => Math.max(max, event.source.offset),
        fromOffset,
      );

      if (!adapter.capabilities.canDistill) {
        await keep({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records: [],
          eventCount: events.length,
          undistilled: true,
        });
        report({ phase: 'done', ...where, records: 0, outcome: 'ingest-only' });
        // The watermark still advances. Re-reading events we cannot distil
        // every sweep would be wasted work with no different outcome.
        recordSuccess(state, key, descriptor, highestOffset, now);
        await checkpoint();
        continue;
      }

      const records = await distill({
        descriptor,
        events,
        fromOffset,
        onProgress: (message) => report({ phase: 'note', ...where, message }),
      });

      if (records === null) {
        await keep({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records: [],
          eventCount: events.length,
          undistilled: true,
        });
        report({ phase: 'done', ...where, records: 0, outcome: 'ingest-only' });
        recordSuccess(state, key, descriptor, highestOffset, now);
        await checkpoint();
        continue;
      }

      // Out of budget rather than in trouble: keep what was done, advance to
      // it, and leave the session eligible so the next sweep carries on.
      const stoppedAt = incompleteCoveredTo(records);
      if (stoppedAt !== false) {
        await keep({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records,
          eventCount: events.length,
          undistilled: false,
          incomplete: true,
        });
        report({ phase: 'done', ...where, records: records.length, outcome: 'partial', reason: 'budget for this run is spent; will continue next time' });
        recordPartial(state, key, descriptor, previous, now, 'stopped early: budget spent', stoppedAt);
        // Not a failure, so it must not count towards giving up on the session.
        const entry = state.sessions[key];
        if (entry) entry.failureCount = previous?.failureCount ?? 0;
        await checkpoint();
        continue;
      }

      const declined = skippedReason(records);
      if (declined !== undefined) {
        await keep({
          sessionId: descriptor.sessionId,
          adapter: descriptor.adapter,
          records: [],
          eventCount: events.length,
          undistilled: false,
          skipped: declined,
        });
        report({ phase: 'done', ...where, records: 0, outcome: 'skipped', reason: declined });
        recordSuccess(state, key, descriptor, highestOffset, now);
        await checkpoint();
        continue;
      }

      const unread = partialFailures(records);
      const reasons = partialReasons(records);

      await keep({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        records,
        eventCount: events.length,
        undistilled: false,
        ...(unread > 0 ? { partial: unread, partialReasons: reasons } : {}),
      });

      report({
        phase: 'done',
        ...where,
        records: records.length,
        outcome: unread > 0 ? 'partial' : 'distilled',
        ...(unread > 0 && reasons[0] ? { reason: reasons[0] } : {}),
      });

      if (unread > 0) {
        // Keep what was read, and resume from the last call that worked rather
        // than from the beginning. Leaving the watermark alone meant one failed
        // call out of fifteen cost the other fourteen again on every sweep.
        recordPartial(
          state,
          key,
          descriptor,
          previous,
          now,
          `${unread} of the session could not be read and will be retried`,
          partialCoveredTo(records),
        );
      } else {
        recordSuccess(state, key, descriptor, highestOffset, now);
      }

      await checkpoint();
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      result.failures.push({
        sessionId: descriptor.sessionId,
        adapter: descriptor.adapter,
        reason,
      });
      report({ phase: 'done', ...where, records: 0, outcome: 'failed', reason });
      recordFailure(state, key, descriptor, previous, now, error);
      await checkpoint();
    }
  }

  return result;
}

function recordSuccess(
  state: SweepState,
  key: string,
  descriptor: SessionDescriptor,
  watermark: number,
  now: Date,
): void {
  state.sessions[key] = {
    sessionId: descriptor.sessionId,
    adapter: descriptor.adapter,
    watermark,
    lastSeenModified: descriptor.lastModified,
    lastSweptAt: now.toISOString(),
    lastError: null,
    failureCount: 0,
  };
}

/**
 * Keeps the ground an interrupted session gained, and keeps it eligible.
 *
 * `lastSeenModified` deliberately stays at its old value. Eligibility skips a
 * session whose file has not changed since a sweep that advanced the watermark,
 * so writing the current mtime here would advance the watermark and then refuse
 * to look at the session again, silently abandoning the part that failed.
 */
function recordPartial(
  state: SweepState,
  key: string,
  descriptor: SessionDescriptor,
  previous: SweepState['sessions'][string] | undefined,
  now: Date,
  reason: string,
  coveredTo: number | undefined,
): void {
  const earned = Math.max(previous?.watermark ?? -1, coveredTo ?? -1);

  state.sessions[key] = {
    sessionId: descriptor.sessionId,
    adapter: descriptor.adapter,
    watermark: earned,
    lastSeenModified: previous?.lastSeenModified ?? '',
    lastSweptAt: now.toISOString(),
    lastError: reason,
    failureCount: (previous?.failureCount ?? 0) + 1,
  };
}

function recordFailure(
  state: SweepState,
  key: string,
  descriptor: SessionDescriptor,
  previous: SweepState['sessions'][string] | undefined,
  now: Date,
  error: unknown,
): void {
  state.sessions[key] = {
    sessionId: descriptor.sessionId,
    adapter: descriptor.adapter,
    // The watermark does not advance on failure, so the region is retried.
    watermark: previous?.watermark ?? -1,
    lastSeenModified: descriptor.lastModified,
    lastSweptAt: now.toISOString(),
    lastError: String(error instanceof Error ? error.message : error),
    failureCount: (previous?.failureCount ?? 0) + 1,
  };
}
