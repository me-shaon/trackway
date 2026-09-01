import { ClaudeDistillRunner } from './claude.js';
import { CodexDistillRunner } from './codex.js';
import { OpenCodeDistillRunner } from './opencode.js';
import { RunnerError, type DistillRunner, type RunOptions } from './contract.js';

/**
 * Every runner Trackway can distil with, in the order it prefers them.
 *
 * Claude Code first because its invocation is the cheapest: extraction is a
 * structured task, so it runs against the small fast model with settings, MCP
 * and tools all switched off. Codex second because `--ephemeral` means its
 * calls leave no session behind at all. OpenCode last because it loads the most
 * per call.
 *
 * Preference, not requirement. Which of these a machine has is not something
 * Trackway gets to decide, and a developer who uses Codex should not have to
 * install Claude Code to read their own sessions back.
 */
export function defaultRunners(): DistillRunner[] {
  return [new ClaudeDistillRunner(), new CodexDistillRunner(), new OpenCodeDistillRunner()];
}

/**
 * Failures that mean this runner will not work at all, however many chunks are
 * tried.
 *
 * A missing binary is the obvious one. An account problem is the one that
 * matters in practice: a runner can pass an availability check, because the
 * binary runs and prints its version, and then fail every single call. Measured
 * on a real machine, `codex exec` returned `402 Payment Required` with
 * `deactivated_workspace` after retrying five times internally. Treating that
 * as a transient chunk failure would spend three attempts per chunk, every
 * chunk, on a runner that was never going to answer.
 */
const DEAD: readonly RegExp[] = [
  /\b401\b|\b402\b|\b403\b/,
  /payment required/i,
  /deactivated/i,
  /unauthor(ised|ized)/i,
  /not logged in|please log in|login required|authenticate/i,
  /quota|credit balance|billing/i,
];

export function isFatal(error: unknown): boolean {
  if (!(error instanceof RunnerError)) return false;
  if (error.kind === 'unavailable') return true;
  return error.kind === 'exit' && DEAD.some((pattern) => pattern.test(error.message));
}

/**
 * Presents several runners as one, falling through as each proves unusable.
 *
 * The fallback is per prompt, not per session: a runner that dies halfway
 * through a long session hands the remaining chunks to the next one rather
 * than losing the session.
 *
 * A runner that fails fatally is struck off for the rest of the process. The
 * alternative is asking a deactivated account the same question once per chunk
 * for the rest of the sweep.
 */
export function createRunnerChain(runners: readonly DistillRunner[]): DistillRunner {
  if (runners.length === 0) {
    throw new Error('a runner chain needs at least one runner');
  }

  const dead = new Set<string>();
  const id = runners.map((runner) => runner.id).join('+');

  const living = (): DistillRunner[] => runners.filter((runner) => !dead.has(runner.id));

  return {
    id,

    async isAvailable() {
      const reasons: string[] = [];

      for (const runner of living()) {
        const availability = await runner.isAvailable().catch((error: unknown) => ({
          available: false,
          reason: String(error),
        }));

        if (availability.available) return { available: true };
        reasons.push(`${runner.id}: ${availability.reason ?? 'unavailable'}`);
      }

      return { available: false, reason: reasons.join('; ') };
    },

    async run(prompt: string, options: RunOptions = {}) {
      const candidates = living();

      if (candidates.length === 0) {
        throw new RunnerError(id, 'unavailable', `every runner failed: ${[...dead].join(', ')}`);
      }

      let last: unknown;

      for (const runner of candidates) {
        try {
          return await runner.run(prompt, options);
        } catch (error) {
          last = error;

          if (!isFatal(error)) throw error; // Transient: let the caller's retry handle it.
          dead.add(runner.id);
        }
      }

      throw last ?? new RunnerError(id, 'unavailable', 'no runner could be used');
    },
  };
}
