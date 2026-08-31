import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const run = promisify(execFile);

export const HOOK_MARKER = 'trackway sync';

export interface HookTarget {
  agent: string;
  settingsPath: string;
}

/**
 * Where each agent keeps user-level settings.
 *
 * User level, not project level, is the whole point: one install covers every
 * repository including ones that do not exist yet. A per-project hook would
 * have to be installed again for each repo and would miss new ones entirely.
 */
export function hookTargets(home: string = homedir()): HookTarget[] {
  return [{ agent: 'claude-code', settingsPath: join(home, '.claude', 'settings.json') }];
}

export interface HookInstallResult {
  agent: string;
  settingsPath: string;
  status: 'installed' | 'already-present' | 'failed';
  reason?: string;
}

/**
 * Adds a hook that fires a sweep as the developer works.
 *
 * The hook does nothing but start a detached sweep. It carries no capture
 * logic, so it cannot slow a session or fail in a way the developer notices,
 * and every command runs the same sweep as a fallback if it is ever removed.
 */
export async function installHook(target: HookTarget, command: string): Promise<HookInstallResult> {
  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFile(target.settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // No settings file yet, or unreadable. Start from an empty object rather
    // than refusing: a fresh install is the common case.
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks['Stop']) ? (hooks['Stop'] as unknown[]) : [];

  const entry = {
    hooks: [{ type: 'command', command, timeout: 5 }],
  };

  // An entry from an older version runs an older command, and the command is
  // where the bounding lives. Leaving it alone meant a fix to the hook never
  // reached anybody who had already installed one.
  const ours = (value: unknown): boolean => JSON.stringify(value).includes(HOOK_MARKER);
  const mine = existing.filter(ours);

  if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) {
    return { agent: target.agent, settingsPath: target.settingsPath, status: 'already-present' };
  }

  const next = {
    ...settings,
    hooks: { ...hooks, Stop: [...existing.filter((value) => !ours(value)), entry] },
  };

  try {
    await mkdir(dirname(target.settingsPath), { recursive: true });
    await writeFile(target.settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { agent: target.agent, settingsPath: target.settingsPath, status: 'installed' };
  } catch (error) {
    return {
      agent: target.agent,
      settingsPath: target.settingsPath,
      status: 'failed',
      reason: String(error instanceof Error ? error.message : error),
    };
  }
}

export async function isHookInstalled(target: HookTarget): Promise<boolean> {
  try {
    const raw = await readFile(target.settingsPath, 'utf8');
    return raw.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * The command the hook runs.
 *
 * Detached and silent, so it cannot block a session. Bounded and interval-aware
 * because it fires on every turn the agent finishes: sweeping the whole backlog
 * each time meant the machine distilled continuously while the developer
 * worked, and a session that failed was retried from the top on the next turn.
 *
 * `--if-due` leaves the interval to config. The bound is on model calls rather
 * than on sessions, because calls are what cost money: three sessions sounds
 * modest and can be forty-five calls if they are long ones. Running out is not
 * a failure, so the session records how far it got and the next firing
 * continues from there.
 *
 * Clearing a large backlog is what running `trackway sync` by hand is for.
 */
export function hookCommand(): string {
  return 'trackway sync --quiet --if-due --max-calls 6 &';
}

/**
 * The git hook, for the agents that have no hook of their own.
 *
 * Claude Code is the only agent that exposes a lifecycle hook, so a Codex or
 * OpenCode session only ever synced when the developer happened to run a
 * Trackway command. A repository worked on entirely through those agents never
 * synced at all.
 *
 * A commit is the agent-agnostic signal. It fires whichever agent did the work,
 * or none, and it is already the moment Trackway cares about: records are
 * linked to the commits their work produced, so syncing at commit time is when
 * that link is freshest.
 */
export const GIT_HOOK_MARKER = '# trackway: sweep sessions that have gone quiet';

const GIT_HOOK_BODY = `${GIT_HOOK_MARKER}
command -v trackway >/dev/null 2>&1 && trackway sync --quiet &
`;

export interface GitHookResult {
  path: string;
  status: 'installed' | 'already-present' | 'appended' | 'failed';
  reason?: string;
}

/**
 * Where this repository keeps its hooks.
 *
 * Asked of git rather than assumed to be `.git/hooks`: a worktree puts them
 * elsewhere, and a repository using husky sets `core.hooksPath`. Writing to the
 * wrong directory would install a hook that never runs and report success.
 */
export async function gitHooksDir(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoRoot });
    const path = stdout.trim();
    if (!path) return null;
    return path.startsWith('/') ? path : join(repoRoot, path);
  } catch {
    return null;
  }
}

export async function isGitHookInstalled(repoRoot: string): Promise<boolean> {
  const dir = await gitHooksDir(repoRoot);
  if (!dir) return false;

  try {
    return (await readFile(join(dir, 'post-commit'), 'utf8')).includes(GIT_HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Adds the sweep to `post-commit`, keeping whatever was already there.
 *
 * Appending rather than replacing, because a repository that already has a
 * post-commit hook has it for a reason, and silently dropping somebody's hook
 * to install our own would be the worst thing this could do.
 */
export async function installGitHook(repoRoot: string): Promise<GitHookResult> {
  const dir = await gitHooksDir(repoRoot);
  if (!dir) {
    return { path: '', status: 'failed', reason: 'not a git repository' };
  }

  const path = join(dir, 'post-commit');

  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // No hook yet, which is the common case.
  }

  if (existing?.includes(GIT_HOOK_MARKER)) {
    return { path, status: 'already-present' };
  }

  try {
    await mkdir(dir, { recursive: true });

    if (existing === null) {
      await writeFile(path, `#!/bin/sh\n${GIT_HOOK_BODY}`, { encoding: 'utf8', mode: 0o755 });
      return { path, status: 'installed' };
    }

    await writeFile(path, `${existing.trimEnd()}\n\n${GIT_HOOK_BODY}`, 'utf8');
    await chmod(path, 0o755);
    return { path, status: 'appended' };
  } catch (error) {
    return {
      path,
      status: 'failed',
      reason: String(error instanceof Error ? error.message : error),
    };
  }
}
