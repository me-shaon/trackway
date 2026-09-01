import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = 'sync.lock';

/**
 * How long a lock is believed before it is treated as abandoned.
 *
 * A sweep of a large backlog legitimately runs for tens of minutes, so this has
 * to be generous. It only matters when a process died without cleaning up,
 * because a live holder is detected directly.
 */
const STALE_AFTER_MS = 60 * 60_000;

export interface Lock {
  release(): void;
}

interface Held {
  pid: number;
  startedAt: string;
}

/**
 * Lets one sweep run at a time per repository.
 *
 * The agent hook fires when a session ends, and a developer with three windows
 * open ends three sessions. Without this each one starts its own sweep over the
 * same sessions, and they race to distil the same events, spend the model calls
 * three times and contend on the same index.
 *
 * `wx` is the whole mechanism: creating the file is atomic, so exactly one
 * caller can win, and there is no window between checking and taking it.
 */
export function acquireSyncLock(cacheDir: string, now: Date = new Date()): Lock | null {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, LOCK_FILE);

  const take = (): Lock | null => {
    try {
      const handle = openSync(path, 'wx');
      closeSync(handle);
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, startedAt: now.toISOString() } satisfies Held),
        'utf8',
      );
      return { release: () => rmSync(path, { force: true }) };
    } catch {
      return null;
    }
  };

  const lock = take();
  if (lock) return lock;

  // Somebody holds it. Whether they are still alive decides everything.
  if (!isStale(path, now)) return null;

  rmSync(path, { force: true });
  return take();
}

/**
 * Whether a held lock belongs to a process that is gone.
 *
 * Signal 0 asks the kernel whether a pid exists without touching it. A lock
 * whose owner has exited is worthless, and leaving it would mean one crashed
 * sweep stops every future one.
 */
function isStale(path: string, now: Date): boolean {
  let held: Held;
  try {
    held = JSON.parse(readFileSync(path, 'utf8')) as Held;
  } catch {
    // Unreadable or half-written. Nothing can be learned from it, so it is not
    // worth trusting either.
    return true;
  }

  if (typeof held.pid === 'number' && held.pid !== process.pid) {
    try {
      process.kill(held.pid, 0);
      // Alive. Age does not matter; a long sweep is a normal thing.
      return false;
    } catch {
      return true; // No such process.
    }
  }

  const age = now.getTime() - Date.parse(held.startedAt);
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}
