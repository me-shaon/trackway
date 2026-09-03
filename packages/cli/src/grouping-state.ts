import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * What was grouped, and how much of it there was at the time.
 *
 * Grouping is asked to put every record under a topic and does not always
 * manage it: a real session of 132 came back with six left over. Those six are
 * enough to make the session look ungrouped forever, so every later run
 * regrouped all 132 to place the same six, at a couple of model calls a time,
 * for as long as the repository existed.
 *
 * Remembering how many records a session had when it was last grouped ends
 * that. New records mean new work; the same records mean the answer is already
 * on disk. It lives in the local cache with the sweep watermarks, because it is
 * per-machine bookkeeping and losing it costs one extra grouping, not
 * correctness.
 */
export interface GroupingState {
  version: 1;
  sessions: Record<string, { records: number; at: string }>;
}

const STATE_FILE = 'grouping-state.json';

export function emptyGroupingState(): GroupingState {
  return { version: 1, sessions: {} };
}

function parse(text: string): GroupingState {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) return emptyGroupingState();

  const { version, sessions } = raw as { version?: unknown; sessions?: unknown };
  if (version !== 1 || typeof sessions !== 'object' || sessions === null) {
    return emptyGroupingState();
  }

  const kept: GroupingState['sessions'] = {};
  for (const [sessionId, value] of Object.entries(sessions as Record<string, unknown>)) {
    const entry = value as { records?: unknown; at?: unknown };
    if (typeof entry?.records !== 'number' || !Number.isFinite(entry.records)) continue;
    kept[sessionId] = { records: entry.records, at: typeof entry.at === 'string' ? entry.at : '' };
  }

  return { version: 1, sessions: kept };
}

export async function loadGroupingState(cacheDir: string): Promise<GroupingState> {
  try {
    return parse(await readFile(join(cacheDir, STATE_FILE), 'utf8'));
  } catch {
    // Missing or unreadable means nothing has been grouped as far as we know,
    // which costs a grouping rather than losing one.
    return emptyGroupingState();
  }
}

/**
 * Records that a session was grouped at this many records.
 *
 * Stamped whether the call produced topics or not. A model that answers
 * unusably answers unusably again, and paying for that on every run is the
 * behaviour this exists to stop; the attempt is reported to the caller instead,
 * and new records make the session eligible again.
 *
 * Written atomically, and never allowed to raise: a lost stamp costs a repeated
 * grouping, and failing the sync over bookkeeping would cost the sync.
 */
export async function stampGrouping(
  cacheDir: string,
  sessionId: string,
  records: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    const state = await loadGroupingState(cacheDir);
    state.sessions[sessionId] = { records, at: now.toISOString() };

    await mkdir(cacheDir, { recursive: true });

    const target = join(cacheDir, STATE_FILE);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;

    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  } catch {
    // Nothing further to do here.
  }
}
