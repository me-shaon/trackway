import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setPriority } from 'node:os';
import { InvalidTranscriptError, defaultRegistry } from '@trackway/adapters';
import {
  TrackwayConfig,
  blameLine,
  commitBySha,
  commitsTouching,
  FOREGROUND_SIGNIFICANCE,
  forgetRecord,
  forgetSession,
  getRecord,
  isRepository,
  listRecords,
  listSessions,
  readAllRecords,
  rebuildIndex,
  removeRecord,
  search,
  searchAlternatives,
  type MemoryRecord,
  type RecordType,
} from '@trackway/core';
import { defaultRunners, loadState, type SweepProgress } from '@trackway/distill';
import { alternativeLine, detail, oneLine, shortDate, truncate } from '../format.js';
import {
  hookCommand,
  hookTargets,
  installGitHook,
  installHook,
  isGitHookInstalled,
  isHookInstalled,
} from '../hook.js';
import { ingestTranscript, sync } from '../pipeline.js';
import { createProgress, formatDuration, type ProgressOptions } from '../progress.js';
import {
  ensureIgnoreRules,
  loadWorkspace,
  openWorkspaceIndex,
  writeConfig,
  type Workspace,
} from '../workspace.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * A line that is replaced rather than added to.
   *
   * Optional, because not every caller has somewhere to put one. Passing the
   * empty string clears it.
   */
  status?: (line: string) => void;
  /** True when `status` can redraw a line in place, so progress can animate. */
  interactive?: boolean;
}

export const consoleIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  interactive: process.stderr.isTTY === true,
  status: (line) => {
    // On a terminal this is one line rewritten in place, so a sync that runs
    // for twenty minutes leaves twenty minutes of progress behind it rather
    // than twenty minutes of scrollback. Anywhere else it is a plain line,
    // because a carriage return in a log file is noise.
    if (!process.stderr.isTTY) {
      if (line) process.stderr.write(`${line}\n`);
      return;
    }

    // A terminal that does not report its width reports zero, not nothing, so
    // `?? 80` left a width of zero and trimmed the last character off every
    // line. Unknown width means print it whole and let the terminal wrap.
    const width = process.stderr.columns;
    const fits = !width || width < 2 || line.length < width;
    process.stderr.write(`\r\u001b[2K${fits ? line : line.slice(0, width - 1)}`);
  },
};

function describeOutcome(event: SweepProgress & { phase: 'done' }): string {
  switch (event.outcome) {
    case 'distilled':
      return `${event.records} record(s)`;
    case 'ingest-only':
      return 'read, but this agent cannot distil';
    case 'partial':
      return `${event.records} record(s), part of it could not be read`;
    case 'failed':
      return `failed: ${truncate(event.reason ?? 'unknown', 80)}`;
    case 'skipped':
      return `skipped: ${truncate(event.reason ?? 'nothing worth extracting', 80)}`;
  }
}

export interface SweepReporter {
  report: (event: SweepProgress) => void;
  /** Ends the animation and leaves the line clean. Safe to call twice. */
  finish: () => void;
}

/**
 * Turns sweep progress into something to watch while it runs.
 *
 * A sync spends most of its time inside one model call that can take minutes,
 * so a line that only changes when a session finishes looks exactly like a
 * hang. It gets killed, and the work is lost. A moving spinner says the process
 * is alive; the bar and the counts say how much is behind it and how much is
 * left.
 */
export function sweepReporter(io: Io, options: ProgressOptions = {}): SweepReporter {
  const progress = createProgress(io, options);

  let total = 0;
  let completed = 0;

  const show = (
    event: Exclude<SweepProgress, { phase: 'planned' }>,
    activity: string,
  ): void => {
    total = event.total;
    progress.set({
      completed,
      total: event.total,
      index: event.index,
      sessionId: event.sessionId,
      activity,
    });
  };

  return {
    finish: () => progress.stop(),

    report: (event) => {
      if (event.phase === 'planned') {
        if (event.eligible === 0) {
          io.out(`Nothing to sync. ${event.discovered} session(s) already up to date.`);
          return;
        }

        const deferred = event.deferred > 0 ? `, ${event.deferred} left for the next run` : '';
        io.out(
          `${event.eligible} session(s) to sync${deferred}. Each one is several model calls, so this takes minutes rather than seconds.`,
        );
        return;
      }

      switch (event.phase) {
        case 'reading':
          show(event, 'reading');
          return;

        case 'distilling':
          show(event, `${event.events} events, distilling`);
          return;

        case 'note':
          show(event, event.message);
          return;

        case 'done': {
          completed += 1;

          // A session that failed or came back incomplete is worth keeping on
          // screen, so it goes to the error stream rather than the line the next
          // session overwrites. One or the other, never both: off a terminal the
          // status line is a printed line too, and doing both said it twice.
          if (event.outcome === 'failed' || event.outcome === 'partial') {
            progress.clear();
            io.err(
              `[${event.index}/${event.total}] ${event.sessionId.slice(0, 8)}  ${describeOutcome(event)}`,
            );
          } else {
            show(event, describeOutcome(event));
          }

          if (event.index === total) progress.stop();
          return;
        }
      }
    },
  };
}

/**
 * Drops this process, and everything it spawns, below normal priority.
 *
 * A sweep is minutes of model subprocesses, each a few hundred megabytes. Run
 * at normal priority from a hook that fires on every agent turn, it competes
 * with the editor and the agent the developer is actually using. Failing to set
 * it is not worth reporting: the sweep is still correct, just less polite.
 */
function yieldTheMachine(): void {
  try {
    setPriority(0, 10);
  } catch {
    // Not permitted on this platform or by this user. Carry on.
  }
}

const NOT_A_REPO = 'Not inside a git repository. Trackway stores records per repository.';

async function requireWorkspace(io: Io): Promise<Workspace | null> {
  const workspace = await loadWorkspace();
  if (!workspace) {
    io.err(NOT_A_REPO);
    return null;
  }

  // A rejected config must never look like no config. Otherwise an edit
  // appears to have no effect and there is nothing to explain why.
  if (workspace.configProblem) io.err(`warning: ${workspace.configProblem}`);

  return workspace;
}

/**
 * Every read command sweeps first.
 *
 * This is the self-heal path. If the agent hook is missing, removed, or the
 * agent has none, records still catch up the next time the developer asks for
 * anything. A failure here is reported and ignored: a search must still return
 * what is already indexed.
 */
async function selfHeal(workspace: Workspace, io: Io, quiet: boolean): Promise<void> {
  try {
    // Progress matters more here than in `sync`, not less. Nobody runs a search
    // expecting to wait, so the catch-up has to say that it is what is holding
    // the answer up.
    const reporter = quiet ? null : sweepReporter(io);

    const result = await sync(workspace, {
      maxSessions: 5,
      ...(reporter ? { onProgress: reporter.report } : {}),
    }).finally(() => reporter?.finish());

    if (!quiet && result.written > 0) {
      io.out(`(distilled ${result.written} new record${result.written === 1 ? '' : 's'})\n`);
    }
    if (!quiet) for (const error of result.errors) io.err(`(sync failed: ${truncate(error, 100)})`);
  } catch (error) {
    if (!quiet) io.err(`(sync skipped: ${String(error)})`);
  }
}

export async function initCommand(options: { hook?: boolean }, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  await writeConfig(workspace.storeDir, TrackwayConfig.parse({}));
  const ignore = await ensureIgnoreRules(workspace.storeDir);

  io.out(`Initialized Trackway in ${workspace.storeDir}`);
  io.out(`  config:      ${workspace.config.storePath}/config.yml`);
  io.out(`  records:     ${workspace.config.storePath}/records/  (tracked by git)`);
  io.out(`  index:       ${workspace.config.storePath}/index.sqlite  (${ignore === 'created' ? 'now ignored' : 'already ignored'})`);
  io.out(`  event cache: outside the repo, purged after ${workspace.config.cacheRetentionDays} days`);

  const registry = defaultRegistry();
  io.out('\nAgents found:');
  for (const status of await registry.status()) {
    const state = status.available
      ? status.canDistill
        ? 'ready'
        : 'ingest only, cannot distil'
      : `unavailable (${status.reason ?? 'unknown'})`;
    io.out(`  ${status.id.padEnd(12)} ${state}`);
  }

  if (options.hook === false) {
    io.out('\nSkipped hook install. Records catch up whenever you run a trackway command.');
    return 0;
  }

  // Claude Code is the only agent with a lifecycle hook, so a repository worked
  // on through Codex or OpenCode never synced on its own. A commit fires
  // whichever agent did the work, and it is already the moment the records are
  // linked to.
  io.out('');
  const git = await installGitHook(workspace.repoRoot);
  if (git.status === 'installed' || git.status === 'appended') {
    io.out(`Git hook ${git.status === 'appended' ? 'added to' : 'installed at'} ${git.path}`);
    io.out('This repository syncs on every commit, whichever agent did the work.');
  } else if (git.status === 'failed') {
    io.err(`Could not install the git hook: ${git.reason ?? 'unknown'}`);
  }

  io.out('');
  for (const target of hookTargets()) {
    // Always offered to the installer rather than skipped when one is present.
    // The command carries the bounding, so an entry from an older version has
    // to be replaced; checking only for presence meant a fix to the hook never
    // reached anybody who had already run this.
    const result = await installHook(target, hookCommand());
    if (result.status === 'already-present') {
      io.out(`Hook already installed for ${target.agent}, and up to date.`);
    } else if (result.status === 'installed') {
      io.out(`Hook installed for ${target.agent} in ${target.settingsPath}`);
      io.out('This is once per machine and covers every repository.');
    } else if (result.status === 'failed') {
      io.err(`Could not install the hook for ${target.agent}: ${result.reason ?? 'unknown'}`);
      io.err('Records will still catch up whenever you run a trackway command.');
    }
  }

  return 0;
}

export async function syncCommand(
  options: { quiet?: boolean; max?: number; ifDue?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  // A hook-triggered sweep runs beside the developer's own work and must lose
  // every contest for the machine. Children inherit this, so the agent
  // subprocesses it spawns are niced too.
  if (options.ifDue) yieldTheMachine();

  const startedAt = Date.now();

  const reporter = options.quiet ? null : sweepReporter(io);

  // Stopped whatever happens, so an interrupted or failed sync cannot leave a
  // spinner ticking over the summary.
  const result = await sync(workspace, {
    ...(options.max === undefined ? {} : { maxSessions: options.max }),
    ...(options.ifDue ? { ifDue: true } : {}),
    ...(reporter ? { onProgress: reporter.report } : {}),
  }).finally(() => reporter?.finish());

  if (options.quiet) return 0;

  // Not an error and not a sweep: say which, rather than reporting zero
  // sessions as though there were none to do.
  if (result.halted) {
    io.out(`Did not sync: ${result.halted}.`);
    return 0;
  }

  const skippedSessions = result.sweep.swept.filter((s) => s.skipped !== undefined);
  const distilled = result.sweep.swept.filter(
    (s) => !s.undistilled && s.skipped === undefined,
  ).length;
  const undistilled = result.sweep.swept.filter((s) => s.undistilled).length;

  io.out(`Swept ${result.sweep.swept.length} session(s) in ${formatDuration(Date.now() - startedAt)}.`);
  io.out(`  distilled:   ${distilled}`);
  if (undistilled > 0) io.out(`  ingest only: ${undistilled} (agent cannot distil)`);
  // Worth its own line rather than being folded into "ingest only": these cost
  // no model call at all, and saying why keeps the count from looking like
  // sessions that were dropped.
  if (skippedSessions.length > 0) {
    io.out(
      `  skipped:     ${skippedSessions.length} (${skippedSessions[0]?.skipped ?? 'nothing to extract'})`,
    );
  }
  io.out(`  records:     ${result.written} new, ${result.skippedExisting} already present`);

  if (result.sweep.deferred > 0) {
    io.out(`  deferred:    ${result.sweep.deferred} (run again to continue)`);
  }

  // A session read in several calls can lose one of them after retries. The
  // records that did come back are kept, and the region that failed is read
  // again next sweep rather than skipped in silence.
  const partial = result.sweep.swept.filter((session) => (session.partial ?? 0) > 0);
  if (partial.length > 0) {
    io.out(
      `  incomplete:  ${partial.length} session(s) had a region that could not be read; run again to retry it`,
    );
    // The count alone says something went wrong and nothing about what, which
    // is the state this whole change exists to get out of.
    for (const session of partial.slice(0, 3)) {
      const reason = session.partialReasons?.[0];
      if (reason) io.err(`    ${session.sessionId.slice(0, 12)}: ${truncate(reason, 90)}`);
    }
  }

  for (const failure of result.sweep.failures) {
    io.err(`  failed: ${failure.sessionId.slice(0, 12)}: ${truncate(failure.reason, 90)}`);
  }

  // The sync itself fell over rather than one session in it. Without this the
  // empty result read as a clean sweep with nothing to do.
  for (const error of result.errors) {
    io.err(`  sync failed: ${truncate(error, 120)}`);
  }
  if (result.errors.length > 0) {
    io.err(`  more detail in ${join(workspace.cacheDir, 'failures.log')}`);
  }

  return 0;
}

export async function statusCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  let total = 0;
  let sessions: ReturnType<typeof listSessions> = [];
  try {
    sessions = listSessions(db);
    total = sessions.reduce((sum, s) => sum + s.recordCount, 0);
  } finally {
    db.close();
  }

  io.out(`Store:   ${workspace.config.storePath}/  (${total} records across ${sessions.length} sessions)`);

  // The index is derived, so it can disagree with the files after a record is
  // deleted by hand. Nothing detected that, and status happily reported 197
  // records when 101 existed.
  const onDisk = await readAllRecords(workspace.recordsDir);
  if (onDisk.records.length !== total) {
    io.out(
      `\nThe index lists ${total} records but ${onDisk.records.length} are on disk. Run: trackway rebuild`,
    );
  }
  if (onDisk.failures.length > 0) {
    io.out(`${onDisk.failures.length} record file(s) could not be read.`);
  }

  io.out('\nAgents:');
  for (const status of await defaultRegistry().status()) {
    const state = status.available
      ? status.canDistill
        ? 'ready'
        : 'ingest only'
      : `unavailable: ${status.reason ?? 'unknown'}`;
    io.out(`  ${status.id.padEnd(12)} ${state}`);
  }

  // An adapter being present says a session can be read. It says nothing about
  // whether anything on this machine can distil it, and that is the failure
  // people actually hit: sessions pile up and every sweep reports the same
  // error per session.
  io.out('\nDistillers:');
  const runners = await Promise.all(
    defaultRunners().map(async (runner) => ({
      id: runner.id,
      availability: await runner.isAvailable().catch(() => ({ available: false as const })),
    })),
  );
  for (const { id, availability } of runners) {
    const state = availability.available
      ? 'ready'
      : `unavailable: ${truncate('reason' in availability ? (availability.reason ?? 'unknown') : 'unknown', 50)}`;
    io.out(`  ${id.padEnd(12)} ${state}`);
  }
  if (!runners.some((runner) => runner.availability.available)) {
    io.out('  Nothing here can distil. Sessions will be found but produce no records.');
  }

  io.out('\nHooks:');
  for (const target of hookTargets()) {
    io.out(`  ${target.agent.padEnd(12)} ${(await isHookInstalled(target)) ? 'installed' : 'not installed'}`);
  }
  // The one that covers the agents with no hook of their own.
  io.out(
    `  ${'git commit'.padEnd(12)} ${(await isGitHookInstalled(workspace.repoRoot)) ? 'installed' : 'not installed'}`,
  );

  // A session that went quiet and never got distilled is the symptom of a
  // broken trigger. Reporting it is what turns silent breakage into visible.
  const state = await loadState(workspace.cacheDir);
  const failed = Object.values(state.sessions).filter((s) => s.lastError !== null);

  if (failed.length > 0) {
    io.out(`\nFailed distillation (${failed.length}):`);
    for (const session of failed.slice(0, 10)) {
      io.out(`  ${session.sessionId.slice(0, 12)}  ${truncate(session.lastError ?? '', 70)}`);
    }
  }

  const pending = await countPending(workspace);
  if (pending > 0) {
    io.out(`\n${pending} quiet session(s) not yet distilled. Run: trackway sync`);
  }

  return 0;
}

async function countPending(workspace: Workspace): Promise<number> {
  try {
    const registry = defaultRegistry();
    const discovered = await registry.listAllSessions({ repoRoot: workspace.repoRoot });
    const state = await loadState(workspace.cacheDir);

    const quietBefore = Date.now() - workspace.config.quietWindowMinutes * 60_000;

    return discovered.filter(({ descriptor }) => {
      if (Date.parse(descriptor.lastModified) > quietBefore) return false;
      const known = state.sessions[`${descriptor.adapter}:${descriptor.sessionId}`];
      return !known || known.lastSeenModified !== descriptor.lastModified;
    }).length;
  } catch {
    return 0;
  }
}

export async function searchCommand(
  query: string,
  options: { type?: string; limit?: number; json?: boolean; noSync?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;
  if (!options.noSync) await selfHeal(workspace, io, options.json === true);

  const db = openWorkspaceIndex(workspace);
  try {
    const hits = search(db, query, {
      ...(options.type ? { types: [options.type as RecordType] } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    if (options.json) {
      io.out(JSON.stringify(hits.map((hit) => hit.record), null, 2));
      return 0;
    }

    if (hits.length === 0) {
      io.out(`Nothing found for "${query}".`);
      return 0;
    }

    io.out(`${hits.length} result(s) for "${query}":\n`);
    for (const hit of hits) io.out(oneLine(hit.record));
    return 0;
  } finally {
    db.close();
  }
}

export async function rejectedCommand(
  query: string | undefined,
  options: { limit?: number; json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const hits = query
      ? searchAlternatives(db, query, options.limit === undefined ? {} : { limit: options.limit })
      : listRecords(db, { types: ['decision'], ...(options.limit === undefined ? {} : { limit: options.limit }) })
          .flatMap((record) =>
            record.type === 'decision'
              ? record.alternatives.map((alternative) => ({
                  decisionId: record.id,
                  decisionChoice: record.choice,
                  choice: alternative.choice,
                  status: alternative.status,
                  reason: alternative.reason,
                  condition: alternative.condition,
                  createdAt: record.createdAt,
                  sessionId: record.sessionId,
                  rank: 0,
                }))
              : [],
          );

    if (options.json) {
      io.out(JSON.stringify(hits, null, 2));
      return 0;
    }

    if (hits.length === 0) {
      io.out(query ? `No discarded options match "${query}".` : 'No discarded options recorded yet.');
      return 0;
    }

    io.out(`${hits.length} option(s) considered and not taken:\n`);
    for (const hit of hits) io.out(`${alternativeLine(hit)}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function decisionsCommand(
  options: { actor?: string; implicit?: boolean; limit?: number; json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const records = listRecords(db, {
      types: ['decision'],
      ...(options.actor ? { actor: options.actor as 'human' | 'agent' } : {}),
      ...(options.implicit ? { implicitOnly: true } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    if (options.json) {
      io.out(JSON.stringify(records, null, 2));
      return 0;
    }

    if (records.length === 0) {
      io.out('No decisions recorded yet.');
      return 0;
    }

    for (const record of records) io.out(oneLine(record));
    return 0;
  } finally {
    db.close();
  }
}

export async function showCommand(
  id: string,
  options: { json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const record = getRecord(db, id);
    if (!record) {
      io.err(`No record with id ${id}.`);
      return 1;
    }

    io.out(options.json ? JSON.stringify(record, null, 2) : detail(record));
    return 0;
  } finally {
    db.close();
  }
}

export async function sessionsCommand(
  options: { json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const sessions = listSessions(db);

    if (options.json) {
      io.out(JSON.stringify(sessions, null, 2));
      return 0;
    }

    if (sessions.length === 0) {
      io.out('No sessions recorded yet. Run: trackway sync');
      return 0;
    }

    for (const session of sessions) {
      io.out(
        `${shortDate(session.lastAt)}  ${session.sessionId.slice(0, 14).padEnd(15)} ${String(session.recordCount).padStart(3)} records  ${session.adapter}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function forgetCommand(
  target: string,
  options: { session?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    if (options.session) {
      const removed = await forgetSession(workspace.recordsDir, target);
      for (const id of removed) removeRecord(db, id);

      io.out(
        removed.length === 0
          ? `No records from session ${target}.`
          : `Removed ${removed.length} record(s) from session ${target}.`,
      );
      return 0;
    }

    const removed = await forgetRecord(workspace.recordsDir, target);
    if (!removed) {
      io.err(`No record with id ${target}.`);
      return 1;
    }

    removeRecord(db, target);
    io.out(`Removed ${target}.`);
    return 0;
  } finally {
    db.close();
  }
}

export async function graphCommandEntry(
  options: { port?: number; open?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const { graphCommand } = await import('./graph.js');
  return graphCommand(workspace, options, io);
}

/**
 * Serves memory to a coding agent over stdio.
 *
 * Read-only. Nothing here can write a record, so distillation stays the single
 * write path.
 */
export async function mcpCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const { serveMcpOverStdio } = await import('@trackway/server');
  const db = openWorkspaceIndex(workspace);

  // stdout carries the protocol, so nothing else may be written to it.
  await serveMcpOverStdio(db);
  return 0;
}

export async function evalCommandEntry(
  options: { limit?: number; json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const { evalCommand } = await import('./eval.js');
  return evalCommand(options, io);
}

export async function rebuildCommand(_options: unknown, io: Io = consoleIo): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  const db = openWorkspaceIndex(workspace);
  try {
    const result = await rebuildIndex(db, workspace.recordsDir);
    io.out(`Rebuilt the index from ${result.indexed} record file(s).`);

    for (const failure of result.failures) {
      io.err(`  unreadable: ${failure.path}: ${failure.reason}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Why is this line like this.
 *
 * The question people actually ask, and the one a decision record is worst at
 * answering on its own: you are looking at code, not at a topic. Blame gives
 * the commit, the commit gives the records whose work produced it, and those
 * records give the options that were on the table when it was written.
 *
 * Retroactive, like the linking behind it. Nothing had to be installed before
 * the commit was made.
 */
/** Decisions answer the question being asked; everything else is context. */
const WHY_ORDER: Record<RecordType, number> = {
  decision: 0,
  question: 1,
  discovery: 2,
  outcome: 3,
  action: 4,
};

function rank(record: MemoryRecord): number {
  return WHY_ORDER[record.type];
}

export async function whyCommand(
  file: string,
  line: string | undefined,
  options: { json?: boolean; limit?: number; all?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  if (!(await isRepository(workspace.repoRoot))) {
    io.err('Not a git repository, so there are no commits to trace back from.');
    return 1;
  }

  const lineNumber = line === undefined ? undefined : Number(line);
  if (lineNumber !== undefined && (!Number.isInteger(lineNumber) || lineNumber < 1)) {
    io.err(`"${line}" is not a line number.`);
    return 1;
  }

  const shas =
    lineNumber === undefined
      ? await commitsTouching(workspace.repoRoot, file)
      : await blameLine(workspace.repoRoot, file, lineNumber).then((sha) => (sha ? [sha] : []));

  if (shas.length === 0) {
    io.err(
      lineNumber === undefined
        ? `Git has no commits for ${file}.`
        : `Git cannot attribute ${file}:${lineNumber}. The line may be uncommitted.`,
    );
    return 1;
  }

  const wanted = new Set(shas);
  const { records } = await readAllRecords(workspace.recordsDir);

  const covering = records.filter((record) =>
    record.commits.some((commit) => wanted.has(commit.sha)),
  );

  // Somebody pointing at a line wants the decision behind it, not the note
  // that a file was edited. Working detail is available behind --all.
  const relevant = options.all
    ? covering
    : covering.filter((record) =>
        (FOREGROUND_SIGNIFICANCE as readonly string[]).includes(record.significance),
      );

  const hits = relevant
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, options.limit ?? 10);

  if (options.json) {
    io.out(JSON.stringify({ file, line: lineNumber ?? null, commits: shas, records: hits }, null, 2));
    return 0;
  }

  if (hits.length === 0) {
    const commit = await commitBySha(workspace.repoRoot, shas[shas.length - 1]!);
    io.err(
      `No ${options.all ? 'record' : 'decision or discovery'} covers ${file}${lineNumber === undefined ? '' : `:${lineNumber}`}.` +
        (commit ? ` Blames to ${commit.sha.slice(0, 8)} by ${commit.author}: ${commit.subject}` : ''),
    );
    io.err(
      covering.length > 0
        ? `Run again with --all to see the ${covering.length} working record${covering.length === 1 ? '' : 's'} that do.`
        : 'Run `trackway sync` if that session has not been distilled yet.',
    );
    return 1;
  }

  io.out(
    `${file}${lineNumber === undefined ? '' : `:${lineNumber}`} — ${hits.length} record${hits.length === 1 ? '' : 's'}`,
  );
  io.out('');
  for (const record of hits) {
    io.out(detail(record));
    io.out('');
  }
  return 0;
}

/**
 * Reads a transcript from a file or from stdin.
 *
 * The way in for an agent with no adapter. Documented in the README so anyone
 * can produce it from a shell script, and refused with the offending field
 * rather than half-read when it is wrong.
 */
export async function ingestCommand(
  file: string | undefined,
  options: { json?: boolean },
  io: Io = consoleIo,
): Promise<number> {
  const workspace = await requireWorkspace(io);
  if (!workspace) return 1;

  let raw: string;
  try {
    raw = file === undefined ? await readStdin() : await readFile(file, 'utf8');
  } catch (cause) {
    io.err(
      file === undefined
        ? 'Nothing arrived on stdin. Pipe a transcript in, or pass a file.'
        : `Could not read ${file}: ${(cause as Error).message}`,
    );
    return 1;
  }

  if (raw.trim().length === 0) {
    io.err('The transcript is empty.');
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    io.err(`That is not JSON: ${(cause as Error).message}`);
    return 1;
  }

  try {
    const result = await ingestTranscript(workspace, parsed);

    if (options.json) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }

    io.out(
      `Read ${result.events} events from ${result.agent} session ${result.sessionId}.`,
    );
    io.out(
      result.written === 0
        ? 'Nothing new: these records were already stored.'
        : `Wrote ${result.written} record${result.written === 1 ? '' : 's'}.`,
    );
    return 0;
  } catch (cause) {
    if (cause instanceof InvalidTranscriptError) {
      io.err(cause.message);
      io.err('The expected shape is documented under "Any other agent" in the README.');
      return 1;
    }
    io.err(`Could not distil that transcript: ${(cause as Error).message}`);
    return 1;
  }
}

/** Reads all of stdin, refusing rather than hanging when it is a terminal. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('stdin is a terminal');

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
