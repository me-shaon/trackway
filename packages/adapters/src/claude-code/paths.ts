import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code keeps its config tree on this machine.
 *
 * Resolved from `CLAUDE_CONFIG_DIR`, which is how Claude Code itself is pointed
 * at a config tree, so a second instance is swept without being configured
 * here as well. Reading it also covers the hook: a sweep triggered from inside
 * a relocated instance inherits the variable and reads that instance's own
 * sessions rather than the default tree.
 *
 * The environment and the home directory arrive as arguments so a test can
 * supply them instead of mutating the process it runs in.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env['CLAUDE_CONFIG_DIR']?.trim();
  return configured ? expandTilde(configured, home) : join(home, '.claude');
}

/** The directory holding one session file per conversation. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(claudeConfigDir(env, home), 'projects');
}

/**
 * A tilde survives into the value only when nothing expanded it, which happens
 * whenever the variable is quoted or set somewhere no shell is involved.
 * Expanding it is cheaper than reporting a missing directory named `~`.
 */
function expandTilde(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}
