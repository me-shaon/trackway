/**
 * Runs a prompt through a coding agent non-interactively and returns its raw
 * text output.
 *
 * Mirrors the adapter contract so a second implementation can be added without
 * touching anything above it. The runner knows nothing about records: it takes
 * a prompt, returns text, and the layer above validates.
 */
export interface DistillRunner {
  readonly id: string;

  /** Whether this runner can be used right now. Never throws. */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  /**
   * Runs the prompt. Throws RunnerError on any failure, including a non-zero
   * exit, a timeout, or unreadable output.
   */
  run(prompt: string, options?: RunOptions): Promise<string>;
}

/**
 * Set in every distillation subprocess, so a sweep can tell it is already
 * inside one.
 *
 * A coding agent runs the developer's hooks when a session ends, and the hook
 * Trackway installs starts a sweep. A sweep distils by starting an agent
 * session, so the sweep's own subprocess fired the hook that starts a sweep.
 * Measured on a real machine: thirty-nine concurrent syncs inside a few
 * minutes, each spawning its own model calls.
 *
 * Disabling hooks in the child is not available: the flag that does it also
 * turns off the OAuth the whole design depends on. So the recursion is broken
 * from Trackway's side instead, which has the advantage of working the same way
 * for every agent rather than depending on one agent's flags.
 */
export const DISTILL_ENV_MARKER = 'TRACKWAY_DISTILLING';

/** True when this process was started by a distillation run. */
export function insideDistillation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISTILL_ENV_MARKER] === '1';
}

/** The environment a runner subprocess gets. */
export function distillEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [DISTILL_ENV_MARKER]: '1' };
}

/**
 * What one call consumed.
 *
 * Reported rather than inferred. A tool that spends the developer's money in
 * the background and never says how much is a tool people stop trusting, and
 * the agents already return this in their result envelope; Trackway was parsing
 * that envelope and throwing the numbers away.
 */
export interface RunUsage {
  inputTokens: number;
  /** Tokens served from cache, which cost a fraction of fresh input. */
  cachedTokens: number;
  outputTokens: number;
  /** What the agent said it cost, when it says. */
  costUsd: number;
}

export function emptyUsage(): RunUsage {
  return { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function addUsage(total: RunUsage, next: RunUsage): RunUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cachedTokens: total.cachedTokens + next.cachedTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    costUsd: total.costUsd + next.costUsd,
  };
}

export interface RunOptions {
  /** Called with what the call consumed, when the agent reports it. */
  onUsage?: (usage: RunUsage) => void;
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class RunnerError extends Error {
  constructor(
    readonly runnerId: string,
    readonly kind: 'unavailable' | 'timeout' | 'exit' | 'output',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${runnerId}: ${message}`, options);
    this.name = 'RunnerError';
  }
}
