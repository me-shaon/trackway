import { defaultRegistry, parseTranscript } from '@trackway/adapters';
import {
  readAllRecords,
  readEpisodes,
  writeEpisodes,
  type Episode,
  attributeToPeople,
  commitsBetween,
  currentIdentity,
  DEFAULT_GRACE_MINUTES,
  isRepository,
  linkCommits,
  upsertRecords,
  writeRecords,
  type MemoryRecord,
} from '@trackway/core';
import {
  addUsage,
  organizeSession,
  createDistiller,
  createRunnerChain,
  defaultRunners,
  emptyUsage,
  insideDistillation,
  type RunUsage,
  purgeCache,
  runSweep,
  type SweepProgress,
  type SweepResult,
} from '@trackway/distill';
import { isolate } from '@trackway/core';
import { join } from 'node:path';
import { acquireSyncLock } from './lock.js';
import { loadGroupingState, stampGrouping } from './grouping-state.js';
import { recordSweep, sweepIsDue } from './schedule.js';
import { openWorkspaceIndex, type Workspace } from './workspace.js';

/**
 * What a sync is doing, sweep or otherwise.
 *
 * Grouping runs after the sweep and outside it, so its progress cannot come
 * from `SweepProgress`. It still has to be reported: a phase that spends model
 * calls behind a silent terminal is the same hang from the outside, and it is
 * the one that follows "Nothing to sync".
 */
export type SyncProgress =
  | SweepProgress
  /** Grouping is about to start on this many sessions whose records have no topics. */
  | { phase: 'grouping-planned'; total: number }
  /** One session is being grouped into topics. */
  | { phase: 'grouping'; index: number; total: number; sessionId: string };

export interface SyncResult {
  sweep: SweepResult;
  written: number;
  skippedExisting: number;
  purgedCacheFiles: number;
  /**
   * Sessions whose grouping call came back unusable.
   *
   * Not a failure of the sync, and not nothing either: the call was paid for
   * and the records still have no topic. Reported so a repository that never
   * grows a topic list has something to explain it.
   */
  groupingProblems: string[];
  /**
   * What went wrong at a level that stopped the sync, rather than one session.
   *
   * Isolation keeps a failure from taking the caller down, but returning the
   * empty result on its own reported the same thing as a clean sweep with
   * nothing to do. A sync that fell over said "Swept 0 session(s)." and left
   * the person running it with nothing to go on.
   */
  errors: string[];
  /** Set when the sweep deliberately did not run. Not a failure. */
  halted?: string;
  /** What the sweep spent. Reported, because a tool that quietly costs money loses trust. */
  spend: RunUsage;
  /** Model calls made. The unit cost actually scales with. */
  calls: number;
}

export interface SyncOptions {
  maxSessions?: number;
  /** Model calls this run may make. Cost scales with calls, so this is the real limit. */
  maxCalls?: number;
  now?: Date;
  onProgress?: (event: SyncProgress) => void;
  /**
   * Run only if the configured interval has passed. The hook sets this; a
   * person typing `trackway sync` does not, because they asked for it now.
   */
  ifDue?: boolean;
}

function empty(): SyncResult {
  return {
    sweep: { swept: [], skipped: [], failures: [], deferred: 0 },
    written: 0,
    skippedExisting: 0,
    purgedCacheFiles: 0,
    groupingProblems: [],
    errors: [],
    spend: emptyUsage(),
    calls: 0,
  };
}

/**
 * A sweep distils by starting an agent session, and an agent runs the
 * developer's hooks when a session ends. The hook Trackway installs starts a
 * sweep. So a sweep's own subprocess fired the hook that starts a sweep, and
 * each of those did it again: thirty-nine concurrent syncs on a real machine in
 * a few minutes, each spending its own model calls.
 *
 * The agent flag that suppresses hooks also disables the OAuth this depends on,
 * so the recursion is refused here instead. Doing it on Trackway's side has the
 * advantage of holding for every agent rather than one agent's flags.
 */
const REENTRANT = 'already running inside a distillation; refusing to sweep recursively';

const BUSY = 'another sync is already running for this repository';

const TOO_SOON = 'swept recently; the hook waits for the configured interval';

/**
 * Sweep, distil, write records, update the index.
 *
 * Nothing here throws. This runs from `trackway sync`, from every other
 * command as a self-heal, and from an agent hook, and in all three cases a
 * failure must be reported rather than raised. Interrupting the developer's
 * coding session is the one outcome this system must never cause.
 *
 * Not raising is not the same as not saying. Whatever was swallowed comes back
 * in `errors` for the caller to print.
 */
export async function sync(workspace: Workspace, options: SyncOptions = {}): Promise<SyncResult> {
  if (insideDistillation()) return { ...empty(), halted: REENTRANT };

  // One sweep per repository. The hook fires per session ending, and three
  // windows closing meant three sweeps racing over the same sessions, spending
  // the same model calls and contending on the same index.
  // Checked before the lock, because being early is not contention and costs
  // nothing to answer.
  if (
    options.ifDue &&
    !sweepIsDue(workspace.cacheDir, workspace.config.minSyncIntervalMinutes, options.now)
  ) {
    return { ...empty(), halted: TOO_SOON };
  }

  const lock = acquireSyncLock(workspace.cacheDir);
  if (!lock) return { ...empty(), halted: BUSY };

  const errors: string[] = [];

  try {
    const result = await isolate(() => runSync(workspace, options), empty(), {
      operation: 'sync',
      logPath: join(workspace.cacheDir, 'failures.log'),
      onFailure: (failure) => errors.push(failure.message),
    });

    // Stamped whether or not it found anything, and whether or not it failed.
    // A sweep that failed is exactly the one that must not be retried on the
    // very next turn of the developer's session.
    recordSweep(workspace.cacheDir, options.now);

    return { ...result, errors: [...result.errors, ...errors] };
  } finally {
    lock.release();
  }
}

async function runSync(workspace: Workspace, options: SyncOptions): Promise<SyncResult> {
  const registry = defaultRegistry();

  let spend = emptyUsage();
  let calls = 0;

  const runner = createRunnerChain(defaultRunners());
  const meter = { onUsage: (usage: RunUsage) => {
    spend = addUsage(spend, usage);
    calls += 1;
  } };

  // Wrapped rather than passed twice, so grouping is counted and reported like
  // any other call instead of being spending nobody sees.
  const metered = {
    id: runner.id,
    isAvailable: () => runner.isAvailable(),
    run: (prompt: string, options = {}) => runner.run(prompt, { ...meter, ...options }),
  };

  // Shared across every session in this sweep, because the thing worth limiting
  // is what the whole run costs, not what any one session costs.
  const callBudget = options.maxCalls === undefined ? undefined : { remaining: options.maxCalls };

  const distill = createDistiller({
    runner,
    onUsage: meter.onUsage,
    ...(callBudget ? { callBudget } : {}),
  });

  let written = 0;
  let skipped = 0;

  // Collected rather than logged and forgotten. A grouping call that comes back
  // unusable leaves every record in that session topicless, which is exactly
  // what a session with nothing worth grouping looks like.
  const groupingProblems: string[] = [];
  const onProblem = (reason: string): void => {
    groupingProblems.push(reason);
  };

  const sweep = await runSweep(registry, distill, {
    cacheDir: workspace.cacheDir,
    quietWindowMinutes: workspace.config.quietWindowMinutes,
    repoRoot: workspace.repoRoot,
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(callBudget ? { hasBudget: () => callBudget.remaining > 0 } : {}),

    // One session at a time, as it finishes. Holding everything until the last
    // session meant a sweep that was interrupted after twenty minutes kept
    // nothing, and the next run started from the beginning. The sweep treats a
    // throw here as that session failing, so its watermark stays put.
    onSession: async (session) => {
      if (session.records.length === 0) return;

      // Linking is derived from history that already exists, so it runs on
      // every record rather than only on ones written while a hook was
      // installed. It is also allowed to fail: a repository with no commits, or
      // none at all, still has a usable record. Attribution follows the link,
      // because a commit author is what the repository itself says about who
      // was working.
      const records = await linkAndAttribute(workspace, session.records);
      const result = await persist(workspace, records);

      written += result.written;
      skipped += result.skipped;

      // Grouping needs the whole session, and only makes sense once there is a
      // whole session to group. A run that stopped early will be back.
      //
      // Counted against the same budget as everything else. Letting it through
      // unmetered meant `--max-calls 8` spent ten, which makes the number a
      // suggestion rather than a limit. A session skipped here is picked up by
      // the catch-up pass on a later run, so nothing is lost by waiting.
      const affordable = !callBudget || callBudget.remaining >= CALLS_PER_GROUPING;

      if (session.partial === undefined && !session.incomplete && affordable) {
        if (callBudget) callBudget.remaining -= CALLS_PER_GROUPING;
        await isolate(
          () => group(workspace, metered, session.sessionId, { onProblem }),
          undefined,
          {
            operation: 'organize',
            logPath: join(workspace.cacheDir, 'failures.log'),
          },
        );
      }
    },
  });

  // Records written before grouping existed, or by a run that could not afford
  // it, would otherwise stay ungrouped forever: their sessions are finished, so
  // no future sweep will look at them again. Catching up here is the same
  // self-heal every read command already does for distillation.
  await isolate(
    () =>
      catchUpGrouping(workspace, metered, callBudget, {
        maxSessions: options.maxSessions ?? CATCH_UP_SESSIONS,
        onProblem,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      }),
    undefined,
    {
      operation: 'organize',
      logPath: join(workspace.cacheDir, 'failures.log'),
    },
  );

  const purge = await purgeCache(
    workspace.cacheDir,
    workspace.config.cacheRetentionDays,
    options.now ?? new Date(),
  ).catch(() => ({ purged: 0, kept: 0 }));

  return {
    sweep,
    written,
    skippedExisting: skipped,
    purgedCacheFiles: purge.purged,
    groupingProblems,
    errors: [],
    spend,
    calls,
  };
}

/**
 * Attaches commits and the person behind them.
 *
 * Retroactive on purpose. A `post-commit` hook can only link commits made after
 * someone installed it; matching a record's own timestamp against the log links
 * everything already in the repository, so a first run is useful immediately.
 */
export async function linkAndAttribute(
  workspace: Workspace,
  records: readonly MemoryRecord[],
): Promise<MemoryRecord[]> {
  if (records.length === 0) return [];

  try {
    if (!(await isRepository(workspace.repoRoot))) return [...records];

    const times = records.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite);
    if (times.length === 0) return [...records];

    const since = new Date(Math.min(...times));
    const until = new Date(Math.max(...times) + DEFAULT_GRACE_MINUTES * 60_000);

    const commits = await commitsBetween(workspace.repoRoot, since, until);
    const identity = await currentIdentity(workspace.repoRoot);

    return attributeToPeople(linkCommits(records, commits), identity);
  } catch {
    // Every part of this is an enrichment. None of it is worth losing a sweep.
    return [...records];
  }
}

/**
 * Writes records to disk, then indexes them.
 *
 * Files first, index second. The index is derived state, so a crash between the
 * two costs a rebuild rather than a lost record.
 */
export async function persist(
  workspace: Workspace,
  records: readonly MemoryRecord[],
): Promise<{ written: number; skipped: number }> {
  if (records.length === 0) return { written: 0, skipped: 0 };

  const results = await writeRecords(workspace.recordsDir, records);

  // Records sharing an identity collapse onto one file, which is the intended
  // dedup. Counting write attempts reported 113 for 101 files; count distinct
  // records instead.
  const written = new Set(results.filter((result) => result.written).map((r) => r.id)).size;

  const db = openWorkspaceIndex(workspace);
  try {
    upsertRecords(db, records);
  } finally {
    db.close();
  }

  return { written, skipped: results.length - written };
}

export interface IngestResult {
  sessionId: string;
  agent: string;
  events: number;
  records: number;
  written: number;
}

/**
 * Reads one transcript in and treats it exactly like a session found on disk.
 *
 * The way in for an agent nobody has written an adapter for. Every adapter so
 * far reads a store somebody else designed, which means support waits on
 * reverse-engineering a format and on having that agent installed to verify
 * against. A documented shape anyone can produce needs neither.
 *
 * Nothing downstream is special-cased. The same distiller runs, the same fork
 * harvesting reads recorded option lists verbatim, the same linking attaches
 * commits, and the same records come out.
 */
export async function ingestTranscript(
  workspace: Workspace,
  input: unknown,
  options: { now?: () => Date } = {},
): Promise<IngestResult> {
  const { descriptor, events } = parseTranscript(input);

  const distill = createDistiller({
    runner: createRunnerChain(defaultRunners()),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const distilled = (await distill({ descriptor, events, fromOffset: 0 })) ?? [];
  const records = await linkAndAttribute(workspace, distilled);
  const { written } = await persist(workspace, records);

  return {
    sessionId: descriptor.sessionId,
    agent: descriptor.sessionFile.split(':')[1] ?? 'unknown',
    events: events.length,
    records: records.length,
    written,
  };
}

/**
 * Fewest records worth grouping into topics.
 *
 * Two records are not a set of topics, they are two records, and asking costs a
 * call to be told so.
 */
const WORTH_GROUPING = 3;

export interface GroupOptions {
  /** Records already read by the caller, so one read serves a whole catch-up pass. */
  records?: readonly MemoryRecord[];
  /** Told when a grouping call was paid for and came back unusable. */
  onProblem?: (reason: string) => void;
}

/**
 * Groups one session's records into topics and settles how important each is.
 *
 * Runs over everything the session has produced, not just what this sweep
 * added, because a topic spans sweeps as easily as it spans chunks.
 *
 * This is what fills the explorer's topic list. Without it every record carries
 * a null episodeId, `/api/overview` groups nothing, and the topic filter in the
 * UI is a control that can never match anything.
 */
export async function group(
  workspace: Workspace,
  runner: Parameters<typeof organizeSession>[0],
  sessionId: string,
  options: GroupOptions = {},
): Promise<void> {
  // The catch-up pass has just read every record to decide what to group, so it
  // hands them over rather than making each session read the whole store again.
  const records = options.records ?? (await readAllRecords(workspace.recordsDir)).records;
  const mine = records.filter((record) => record.sessionId === sessionId);

  if (mine.length < WORTH_GROUPING) return;

  // Regrouping costs the same whether one record arrived or fifty, so a couple
  // of stragglers are left for the next time enough of them accumulate. Nothing
  // is lost: they are grouped as soon as there are enough to be worth a call.
  const ungrouped = mine.filter((record) => record.episodeId === null);
  if (ungrouped.length < WORTH_GROUPING) return;

  const organized = await organizeSession(runner, mine, {
    onProblem: (reason) => options.onProblem?.(`${sessionId.slice(0, 8)}: ${reason}`),
  });

  // Stamped on the attempt, not on success. The model does not always place
  // every record, and the handful it leaves behind are enough to make a session
  // look ungrouped for good: without this, the same session was regrouped on
  // every run for as long as the repository existed.
  await stampGrouping(workspace.cacheDir, sessionId, mine.length);

  if (organized.episodes.length === 0) return;

  // The model numbers topics from one for every session it sees, so the ids
  // have to be made unique before they reach a store holding every session.
  const prefix = sessionId.slice(0, 8);
  const rename = (id: string): string => `${prefix}-${id}`;

  const updated = organized.records.map((record) =>
    record.episodeId === null ? record : { ...record, episodeId: rename(record.episodeId) },
  );

  await persist(workspace, updated);

  const mineNow: Episode[] = organized.episodes.map((episode) => ({
    id: rename(episode.id),
    title: episode.title,
    sessionId,
  }));

  // Read, replace this session's topics, write. Anything else would drop every
  // other session's topics on each sweep.
  const existing = await readEpisodes(workspace.storeDir);
  await writeEpisodes(workspace.storeDir, [
    ...existing.filter((episode) => episode.sessionId !== sessionId),
    ...mineNow,
  ]);
}

/** Calls one grouping costs, used to decide whether the budget can afford another. */
const CALLS_PER_GROUPING = 2;

/**
 * Sessions the catch-up pass will group in one run when no session cap is given.
 *
 * Every read command sweeps as a self-heal, so this bounds a `search` as well
 * as a `sync`. Five sessions is a bounded wait rather than an open-ended one,
 * and the backlog clears over the runs that follow.
 */
const CATCH_UP_SESSIONS = 5;

/**
 * Groups sessions whose records were written before anything grouped them.
 *
 * Bounded by the same budget as everything else, and it takes the smallest
 * sessions first: grouping is priced per record, so the cheapest ones clear the
 * backlog fastest and a single enormous session cannot eat a whole run.
 */
export async function catchUpGrouping(
  workspace: Workspace,
  runner: Parameters<typeof organizeSession>[0],
  budget: { remaining: number } | undefined,
  options: {
    maxSessions: number;
    onProblem?: (reason: string) => void;
    onProgress?: (event: SyncProgress) => void;
  },
): Promise<void> {
  const { records } = await readAllRecords(workspace.recordsDir);
  const grouped = await loadGroupingState(workspace.cacheDir);

  const bySession = new Map<string, number>();
  const ungrouped = new Set<string>();

  for (const record of records) {
    bySession.set(record.sessionId, (bySession.get(record.sessionId) ?? 0) + 1);
    if (record.episodeId === null) ungrouped.add(record.sessionId);
  }

  const candidates = [...ungrouped]
    .filter((id) => (bySession.get(id) ?? 0) >= WORTH_GROUPING)
    // Nothing new since the last grouping means the same question with the same
    // input, and the same answer is already on disk.
    .filter((id) => (bySession.get(id) ?? 0) > (grouped.sessions[id]?.records ?? -1))
    .sort((a, b) => (bySession.get(a) ?? 0) - (bySession.get(b) ?? 0))
    // Capped per run for the same reason the sweep is. A repository with a
    // year of history behind it has a backlog measured in hours of model calls,
    // and a command nobody can wait out is a command people kill. The pass is
    // idempotent, so what is left is picked up by the next run.
    .slice(0, Math.max(0, options.maxSessions));

  if (candidates.length === 0) return;

  options.onProgress?.({ phase: 'grouping-planned', total: candidates.length });

  let index = 0;

  for (const sessionId of candidates) {
    if (budget && budget.remaining < CALLS_PER_GROUPING) return;
    if (budget) budget.remaining -= CALLS_PER_GROUPING;

    index += 1;
    options.onProgress?.({ phase: 'grouping', index, total: candidates.length, sessionId });

    await group(workspace, runner, sessionId, {
      records,
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
    });
  }
}
