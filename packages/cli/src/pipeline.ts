import { defaultRegistry, parseTranscript } from '@trackway/adapters';
import {
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
import { recordSweep, sweepIsDue } from './schedule.js';
import { openWorkspaceIndex, type Workspace } from './workspace.js';

export interface SyncResult {
  sweep: SweepResult;
  written: number;
  skippedExisting: number;
  purgedCacheFiles: number;
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
  onProgress?: (event: SweepProgress) => void;
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

  // Shared across every session in this sweep, because the thing worth limiting
  // is what the whole run costs, not what any one session costs.
  const callBudget = options.maxCalls === undefined ? undefined : { remaining: options.maxCalls };

  const distill = createDistiller({
    runner: createRunnerChain(defaultRunners()),
    onUsage: (usage) => {
      spend = addUsage(spend, usage);
      calls += 1;
    },
    ...(callBudget ? { callBudget } : {}),
  });

  let written = 0;
  let skipped = 0;

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
    },
  });

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
