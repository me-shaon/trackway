import type { MemoryEvent } from '@trackway/core';

/**
 * Events per distillation call.
 *
 * Chosen so a chunk fits comfortably in one request alongside the instructions,
 * with room for long tool output.
 */
export const DEFAULT_CHUNK_SIZE = 120;

/**
 * Events repeated at the start of the next chunk. Zero by default.
 *
 * Overlap was 12, on the reasoning that a decision is often stated a few turns
 * after the question prompting it, and cutting between them loses both.
 * Dogfooding showed the cost is worse than the benefit: the same decision
 * appeared in both chunks and came back worded differently each time, so four
 * records described one decision. Content-derived ids cannot collapse those,
 * and lexical comparison cannot either. Measured against real pairs, true
 * duplicates scored 0.33 to 0.86 while genuinely different decisions reached
 * 0.50, so no threshold separates them.
 *
 * Disjoint chunks cannot produce that duplication at all. The failure it
 * reintroduces is benign by comparison: a decision spanning a boundary is
 * recorded as a question in one chunk and a decision in the next, and both
 * records are individually true and useful.
 */
export const DEFAULT_OVERLAP = 0;

/**
 * How large one request may get, in characters of rendered prompt.
 *
 * Event count is the wrong unit and using it caused real timeouts. Events vary
 * enormously in size, so a fixed count of them is not a fixed request: a
 * 2687-event session widened to 224 events per chunk produced a first chunk of
 * 91k characters, roughly 23k tokens, against chunks of 41k that had been
 * measured at 54 seconds. It timed out at 300 seconds, twice, and eleven
 * minutes went into one chunk that never landed.
 *
 * 45k is just above the largest size measured completing comfortably, which
 * leaves the 300 second limit as headroom for a slow day rather than as the
 * thing every large chunk runs into.
 */
export const DEFAULT_MAX_CHUNK_CHARS = 45_000;

export interface Chunk {
  events: MemoryEvent[];
  fromOffset: number;
  toOffset: number;
  index: number;
  total: number;
}

/**
 * Splits a session into windows that each fit one call.
 *
 * Truncating instead was the first approach and it was wrong: a session with 27
 * decision points produced 5 records because the extractor never saw past the
 * first 200 events. Silent truncation is worse than a missing feature, because
 * the output looks complete.
 */
export function chunkEvents(
  events: readonly MemoryEvent[],
  options: {
    chunkSize?: number;
    overlap?: number;
    /** Ceiling on one chunk's rendered size. Omit to bound by count alone. */
    maxChars?: number;
    /** How large one event renders. Supplied by the caller that owns the prompt. */
    sizeOf?: (event: MemoryEvent) => number;
  } = {},
): Chunk[] {
  const size = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, size - 1));

  if (events.length === 0) return [];

  // Two ceilings, whichever is reached first. Count keeps a chunk readable as
  // one conversation; size keeps it inside one request. Neither alone is
  // enough: count alone produced 91k-character chunks that timed out.
  if (options.maxChars !== undefined && options.sizeOf) {
    return pack(events, size, options.maxChars, options.sizeOf);
  }

  if (events.length <= size) {
    return [
      {
        events: [...events],
        fromOffset: events[0]!.source.offset,
        toOffset: events[events.length - 1]!.source.offset,
        index: 0,
        total: 1,
      },
    ];
  }

  const windows: MemoryEvent[][] = [];
  const step = size - overlap;

  for (let start = 0; start < events.length; start += step) {
    const window = events.slice(start, start + size);
    if (window.length === 0) break;
    windows.push(window);
    if (start + size >= events.length) break;
  }

  return numbered(windows);
}

/**
 * Fills chunks up to whichever ceiling comes first.
 *
 * A single event larger than the budget still gets its own chunk rather than
 * being dropped: the prompt renderer truncates each event anyway, so an
 * oversized one is already bounded, and losing it would be worse than one
 * larger request.
 */
function pack(
  events: readonly MemoryEvent[],
  size: number,
  maxChars: number,
  sizeOf: (event: MemoryEvent) => number,
): Chunk[] {
  const windows: MemoryEvent[][] = [];
  let current: MemoryEvent[] = [];
  let chars = 0;

  for (const event of events) {
    const cost = sizeOf(event);
    const full = current.length >= size || (current.length > 0 && chars + cost > maxChars);

    if (full) {
      windows.push(current);
      current = [];
      chars = 0;
    }

    current.push(event);
    chars += cost;
  }

  if (current.length > 0) windows.push(current);
  return numbered(windows);
}

function numbered(windows: MemoryEvent[][]): Chunk[] {
  return windows.map((window, index) => ({
    events: window,
    fromOffset: window[0]!.source.offset,
    toOffset: window[window.length - 1]!.source.offset,
    index,
    total: windows.length,
  }));
}
