import { withDerivedId, type MemoryEvent, type MemoryRecord } from '@trackway/core';
import { DEFAULT_CHUNK_SIZE, DEFAULT_MAX_CHUNK_CHARS, chunkEvents } from './chunk.js';
import { describeForksForPrompt, forkAlternatives, harvestForks, type HarvestedFork } from './harvest.js';
import { collapseNearDuplicates } from './dedupe.js';
import { buildPrompt, isOwnExtraction, renderedSize } from './prompts/extract.js';
import { RunnerError, type DistillRunner, type RunUsage } from './runner/contract.js';
import { toRecords } from './runner/validate.js';
import { markIncomplete, markPartial, markSkipped, type Distiller } from './sweep/run.js';

export interface DistillerOptions {
  runner: DistillRunner;
  now?: () => Date;
  chunkSize?: number;
  /** Caps calls per session so one enormous session cannot run away. */
  maxChunks?: number;
  /** Attempts per chunk before it is given up on. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay between attempts. Exposed so tests need not wait it out. */
  retryDelayMs?: number;
  /** Ceiling on one request's rendered size. Events vary too much to bound by count. */
  maxChunkChars?: number;
  /** Called with what each call consumed, so a sync can report what it spent. */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Model calls this sweep may still make, shared across every session in it.
   *
   * Cost is calls, so calls are what a background sweep has to be bounded by.
   * Bounding sessions instead let one firing of the hook spend forty-five calls
   * on three long sessions. Running out is not a failure: the session records
   * how far it got and the next sweep continues from there.
   */
  callBudget?: { remaining: number };
  onProgress?: (message: string) => void;
}

const DEFAULT_MAX_CHUNKS = 12;

/**
 * How many times one chunk may be sent before it is given up on.
 *
 * A chunk of this session's size takes 27 to 70 seconds against a 300 second
 * limit, so a timeout does not mean the request was too large. It means
 * something transient went wrong, which is the one case worth trying again.
 * Raising the limit was tried first, from 120 seconds to 300, and a later run
 * still lost a session: more patience does not help a request that stalled.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Grows between attempts so a struggling machine is not hit at the same rate. */
const RETRY_BACKOFF_MS = 2_000;

/**
 * Failures worth another attempt.
 *
 * A missing binary will still be missing in two seconds, and retrying it
 * three times only makes the wait before the real message longer. A timeout or
 * a crashed process is circumstance rather than a verdict. Malformed output is
 * retried too, because the model is sampled and a second draw often parses.
 */
const TRANSIENT: ReadonlySet<string> = new Set(['timeout', 'exit', 'output']);

function isWorthRetrying(error: unknown): boolean {
  return error instanceof RunnerError && TRANSIENT.has(error.kind);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a chunk contains anything a record could be made of.
 *
 * Records come from what people said and what the agent said about it. A run of
 * tool calls and their output carries neither: no question was asked, no choice
 * was argued, nothing was concluded in words. Sending it costs a full call to
 * be told there is nothing there.
 *
 * Deliberately generous. Any developer message at all counts, and so does any
 * agent message with real prose in it, because the cost of keeping a chunk that
 * turns out to be empty is one call, while the cost of dropping one that was
 * not is a decision lost for good.
 */
const PROSE_ENOUGH_TO_MATTER = 200;

export function couldHoldARecord(events: readonly MemoryEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'user_prompt' ||
      (event.type === 'agent_message' && renderedSize(event) >= PROSE_ENOUGH_TO_MATTER) ||
      event.type === 'error',
  );
}

/** One line a person can act on, rather than a stack trace or `[object Object]`. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a recorded fork into a record.
 *
 * Attribution is certain here in a way it never is from prose: the agent asked
 * and a person answered, so it is recorded as exactly that.
 *
 * Not every fork is a decision. A dismissed one is a question nobody answered,
 * and calling it a decision produced records that showed the reader a fork and
 * could not say which way it went. A freehand answer is a decision the
 * developer wrote themselves, with every offered option rejected.
 */
function forkToRecord(
  fork: HarvestedFork,
  sessionId: string,
  adapter: string,
  sessionFile: string,
): MemoryRecord {
  const source = {
    adapter,
    sessionId,
    sessionFile,
    fromOffset: fork.offset,
    toOffset: fork.offset,
  };

  const common = {
    sessionId,
    episodeId: null,
    commits: [],
    createdAt: fork.timestamp,
    source,
  };

  if (fork.outcome.kind === 'declined') {
    return withDerivedId({
      ...common,
      type: 'question' as const,
      significance: 'technical' as const,
      question: fork.question,
      answer: null,
      status: 'open' as const,
      actor: { type: 'agent' as const, id: `agent:${adapter}` },
    }) as MemoryRecord;
  }

  const outcome = fork.outcome;
  const answered = outcome.kind === 'answered';
  const choice = outcome.kind === 'answered' ? outcome.text : outcome.label;

  return withDerivedId({
    ...common,
    type: 'decision' as const,
    significance: 'technical' as const,
    question: fork.question,
    choice,
    reason: answered
      ? 'Written by the developer rather than taken from the options offered.'
      : (fork.options.find((option) => option.label === choice)?.reason ??
        'The session recorded the choice but no reasoning for it.'),
    alternatives: forkAlternatives(fork),
    attribution: {
      // A freehand answer came from the developer, so they proposed it. The
      // agent only proposed the options they turned down.
      proposedBy: answered
        ? ({ type: 'human' as const, id: 'human:local' } as const)
        : ({ type: 'agent' as const, id: `agent:${adapter}` } as const),
      acceptedBy: { type: 'human' as const, id: 'human:local' } as const,
    },
    status: 'accepted' as const,
    supersededBy: null,
    relationships: [],
  }) as MemoryRecord;
}

/**
 * Drops model decisions that restate a fork already read from the session.
 *
 * The prompt asks the model not to re-emit these and it does anyway. That is
 * the same lesson the discovery triage learned: a rule buried in a larger
 * prompt is a request, not a constraint, and only code enforces it.
 *
 * Identity cannot catch these on its own, because a decision is identified by
 * its choice and the model rewords the choice. The question is the reliable
 * key: it comes verbatim from structured tool input, and two genuinely
 * different decisions do not share one word for word.
 */
function withoutReharvested(
  records: readonly MemoryRecord[],
  forks: readonly HarvestedFork[],
): MemoryRecord[] {
  if (forks.length === 0) return [...records];

  const asked = new Set(forks.map((fork) => normalizeSubject(fork.question)));

  return records.filter(
    (record) => record.type !== 'decision' || !asked.has(normalizeSubject(record.question)),
  );
}

/** Matches the folding the ID derivation uses, so the two agree on sameness. */
function normalizeSubject(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function dedupe(records: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Map<string, MemoryRecord>();
  for (const record of records) if (!seen.has(record.id)) seen.set(record.id, record);
  return [...seen.values()];
}

/**
 * Wires a runner and the extraction prompt into the sweep's Distiller shape.
 *
 * Returns null rather than throwing when there is nothing worth sending, so the
 * sweep records the region as handled instead of retrying it forever.
 */
export function createDistiller(options: DistillerOptions): Distiller {
  const now = options.now ?? (() => new Date());

  return async ({ descriptor, events, fromOffset, onProgress }): Promise<MemoryRecord[] | null> => {
    if (events.length === 0) return null;

    // Our own distillation calls are sessions too, and they were being read
    // back and sent to the model to discover they hold nothing. Returning null
    // marks the session handled without spending a call on it.
    if (isOwnExtraction(events)) {
      return markSkipped('one of our own distillation calls, not real work');
    }

    // The per-call channel wins when the caller supplies one, because it knows
    // which session this is and the distiller is reused across all of them.
    const report = onProgress ?? options.onProgress ?? (() => {});

    /*
     * Forks the session recorded literally are taken as given rather than
     * re-derived. They carry the exact question, every option, and each
     * option's own argument, written before anyone knew which way it would go.
     * Asking a model to reconstruct that from prose loses most of it: measured
     * on one real session, twelve recorded forks came back as decisions with a
     * median of one alternative.
     */
    const forks = harvestForks(events);
    const harvested = forks.map((fork) =>
      forkToRecord(fork, descriptor.sessionId, descriptor.adapter, descriptor.sessionFile),
    );

    const cap = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

    // A very long session widens its chunks rather than losing its tail.
    // Capping the number of chunks alone still drops the end of a session, and
    // dropping the end is exactly the failure this replaced: a 2100-event
    // session would have been read only to the two-thirds mark.
    const requested = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.max(requested, Math.ceil(events.length / cap));

    // Two ceilings. Widening by count alone put 91k characters into one request
    // on a 2687-event session, which timed out at 300 seconds twice and lost
    // eleven minutes to a chunk that never landed. The same events split by
    // size cost about the same in total, because it is the same transcript
    // either way, and no single call sits near the limit.
    const batch = chunkEvents(events, {
      chunkSize,
      maxChars: options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
      sizeOf: renderedSize,
    });

    const records: MemoryRecord[] = [];
    const failures: unknown[] = [];

    // How far an unbroken run of successful calls has reached. Chunks are
    // ordered by offset, so once one fails nothing after it counts as covered
    // however well it went: the next sweep must re-read from the gap.
    let coveredTo: number | undefined;
    let broken = false;
    let outOfBudget = false;

    for (const chunk of batch) {
      // Said before the call rather than after it. Each chunk is a model call
      // that takes the better part of a minute, and the wait is the part that
      // needs explaining, not the result.
      report(`chunk ${chunk.index + 1} of ${chunk.total}`);

      const inChunk = forks.filter(
        (fork) => fork.offset >= chunk.fromOffset && fork.offset <= chunk.toOffset,
      );

      const prompt = buildPrompt({
        events: chunk.events,
        adapterId: descriptor.adapter,
        ...(chunk.total > 1 ? { part: { index: chunk.index + 1, total: chunk.total } } : {}),
        ...(inChunk.length > 0 ? { alreadyCaptured: describeForksForPrompt(inChunk) } : {}),
      });

      if (options.callBudget && options.callBudget.remaining <= 0) {
        report(`stopping at chunk ${chunk.index + 1} of ${chunk.total}: budget for this run is spent`);
        outOfBudget = true;
        break;
      }

      // Nobody decides anything in a stretch of pure tool traffic. A chunk with
      // no developer message and no agent prose has nothing a record could be
      // made of, and asking costs a call to be told so. Measured across one
      // repository, 8% of chunks look like this.
      if (!couldHoldARecord(chunk.events)) {
        report(`chunk ${chunk.index + 1} of ${chunk.total} skipped: nothing but tool traffic`);
        if (!broken) coveredTo = chunk.toOffset;
        continue;
      }

      const attempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      let lastError: unknown;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          if (options.callBudget) options.callBudget.remaining -= 1;
          const output = await options.runner.run(prompt, {
            ...(options.onUsage ? { onUsage: options.onUsage } : {}),
          });

          records.push(
            ...toRecords(output, {
              sessionId: descriptor.sessionId,
              adapter: descriptor.adapter,
              sessionFile: descriptor.sessionFile,
              fromOffset: Math.max(chunk.fromOffset, 0),
              toOffset: chunk.toOffset,
              createdAt: chunk.events.at(-1)?.timestamp ?? now().toISOString(),
            }),
          );
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= attempts || !isWorthRetrying(error)) break;

          report(
            `session ${descriptor.sessionId}: chunk ${chunk.index + 1} of ${chunk.total} ` +
              `failed (${(error as RunnerError).kind}), retrying ${attempt + 1} of ${attempts}`,
          );
          await wait((options.retryDelayMs ?? RETRY_BACKOFF_MS) * attempt);
        }
      }

      if (lastError !== undefined) {
        // One bad chunk must not cost the whole session. A long session is
        // exactly where losing everything hurts most.
        failures.push(lastError);
        broken = true;
        report(
          `chunk ${chunk.index + 1} of ${chunk.total} gave up: ${describeFailure(lastError)}`,
        );
      } else if (!broken) {
        coveredTo = chunk.toOffset;
      }
    }

    if (records.length === 0 && harvested.length === 0 && failures.length > 0) {
      // Rethrow the original rather than wrapping it. The sweep distinguishes a
      // runner failure from invalid output, and a wrapper would erase that.
      //
      // Only when the harvest is empty too. Forks are read straight out of the
      // session and cost no model call, so a runner that cannot start is no
      // reason to discard them. Throwing here meant `trackway ingest` returned
      // nothing at all on a machine with no agent installed, when everything
      // the transcript recorded literally was already in hand.
      throw failures[0];
    }

    // Two passes. Identical records collapse on their id; records that say the
    // same thing in different words need comparing, because the model rewords
    // between chunks and a hash of different words is a different hash.
    // Harvested forks come first so a near-duplicate from the model collapses
    // into the recorded one rather than replacing it.
    const distilled = collapseNearDuplicates(
      dedupe([...harvested, ...withoutReharvested(records, forks)]),
    );

    // Some chunks failed and others did not. Say so, so the sweep can keep
    // these records without treating the session as fully read.
    if (failures.length > 0) {
      return markPartial(distilled, failures.length, failures.map(describeFailure), coveredTo);
    }

    // Stopped on purpose rather than in trouble. The sweep advances the
    // watermark to what was covered and leaves the rest for next time.
    return outOfBudget ? markIncomplete(distilled, coveredTo) : distilled;
  };
}
