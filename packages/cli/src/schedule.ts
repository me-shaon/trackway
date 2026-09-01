import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STAMP = 'last-sweep';

/**
 * When a sweep last finished for this repository.
 *
 * Kept beside the watermarks rather than in them: it is about how often we run,
 * not about how far we have read, and it must survive a sweep that read nothing.
 */
export function lastSweepAt(cacheDir: string): Date | null {
  try {
    const at = Date.parse(readFileSync(join(cacheDir, STAMP), 'utf8').trim());
    return Number.isFinite(at) ? new Date(at) : null;
  } catch {
    return null;
  }
}

export function recordSweep(cacheDir: string, now: Date = new Date()): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, STAMP), now.toISOString(), 'utf8');
  } catch {
    // Losing the stamp costs an extra sweep, not correctness.
  }
}

/**
 * Whether a hook-triggered sweep is due.
 *
 * The agent fires its Stop hook every time it finishes a turn, many times an
 * hour. Without this the machine distils continuously while the developer
 * works, and a session that failed is retried from the top on the next turn.
 * A person running `trackway sync` themselves is always due: they asked.
 */
export function sweepIsDue(
  cacheDir: string,
  minIntervalMinutes: number,
  now: Date = new Date(),
): boolean {
  if (minIntervalMinutes <= 0) return true;

  const last = lastSweepAt(cacheDir);
  if (!last) return true;

  return now.getTime() - last.getTime() >= minIntervalMinutes * 60_000;
}
