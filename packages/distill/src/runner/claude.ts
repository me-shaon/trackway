import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  RunnerError,
  distillEnv,
  type DistillRunner,
  type RunOptions,
  type RunUsage,
} from './contract.js';

const RUNNER_ID = 'claude-code';
/**
 * Raised from 120s after a real eval run lost a session to a timeout. A chunk
 * of 120 events with long tool output is a large request, and losing the whole
 * session costs more than waiting longer for it.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Extraction is a structured task, so it defaults to the cheap fast model. */
export const DEFAULT_DISTILL_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Settings for the subprocess. Empty except for one thing that matters a lot.
 *
 * Thinking is 95% of what a distillation call emits: measured on a real chunk,
 * 5380 thinking tokens to produce 958 characters of JSON. Output is priced far
 * above input, so that one setting is the largest single cost in a sync.
 *
 * It is not a quality trade. Extraction is a transcription task against an
 * explicit schema, not a reasoning one, and the transcript is already in front
 * of the model. Measured over four real chunks, turning it off cut output
 * tokens by 71% and found more of what was there, not less.
 */
export const DISTILL_SETTINGS = '{"alwaysThinkingEnabled":false}';

export interface ClaudeRunnerOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  /** Let the model think before answering. Off by default; see DISTILL_SETTINGS. */
  thinking?: boolean;
  /** Where the subprocess runs. Exposed so tests need not touch the real one. */
  workingDir?: string;
}

/**
 * Where a distillation subprocess is run from.
 *
 * Not the repository, which is the whole point. Claude Code records the working
 * directory in the session file it writes for every `-p` invocation, and
 * Trackway matches sessions to a repository by exactly that field. Run from the
 * repository and each distillation call produces a session that the next sweep
 * discovers and distils, which produces another one. Thirty-five calls became
 * thirty-five new sessions became thirty-five more calls, and it never settles.
 *
 * A directory that belongs to no repository breaks the loop at the source: the
 * exhaust still exists, it just cannot be attributed to a repository, so it is
 * never eligible for one.
 */
export function runnerWorkingDir(home: string = homedir()): string {
  return join(home, '.trackway', 'runner');
}

/**
 * Runs the developer's own Claude Code non-interactively.
 *
 * This is what makes "no second API key" real rather than aspirational: the
 * subprocess reuses the authentication already on the machine. It is still a
 * separate inference, with its own cost and rate-limit draw, which is why the
 * invocation is stripped down as far as it goes.
 *
 * A plain `claude -p` inherits the developer's settings, plugins, and MCP
 * servers. Measured against a two-word prompt that cost $0.19 a call, almost
 * all of it loading context the extractor never uses. Disabling settings, MCP,
 * and tools brings the same call to $0.02.
 *
 * It never runs inside the developer's session and never touches its context.
 */
export class ClaudeDistillRunner implements DistillRunner {
  readonly id = RUNNER_ID;

  private readonly binary: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly workingDir: string;
  private readonly settings: string;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.model = options.model ?? DEFAULT_DISTILL_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workingDir = options.workingDir ?? runnerWorkingDir();
    this.settings = options.thinking === true ? '{}' : DISTILL_SETTINGS;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.exec(['--version'], '', 10_000);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof RunnerError ? error.message : String(error),
      };
    }
  }

  async run(prompt: string, options: RunOptions = {}): Promise<string> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      this.model,
      // Nothing from the developer's environment. The extractor needs the model
      // and the prompt, and loading anything else is cost with no benefit.
      '--settings',
      this.settings,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      // Extraction reads the prompt and writes JSON. It has no reason to touch
      // the filesystem, and denying that outright is cheaper than trusting it.
      '--disallowed-tools',
      'Bash,Read,Write,Edit,NotebookEdit,WebSearch,WebFetch,Task,Glob,Grep',
    ];

    const raw = await this.exec(args, prompt, options.timeoutMs ?? this.timeoutMs, options.signal);

    let envelope: { result?: unknown; is_error?: unknown; usage?: unknown; total_cost_usd?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch (cause) {
      throw new RunnerError(RUNNER_ID, 'output', 'output was not valid JSON', { cause });
    }

    options.onUsage?.(readUsage(envelope));

    if (envelope.is_error === true) {
      throw new RunnerError(RUNNER_ID, 'exit', `agent reported an error: ${String(envelope.result)}`);
    }

    if (typeof envelope.result !== 'string') {
      throw new RunnerError(RUNNER_ID, 'output', 'response envelope carried no result text');
    }

    return envelope.result;
  }

  private exec(
    args: string[],
    input: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;

      try {
        // Created rather than assumed: spawn fails outright if cwd is missing,
        // and a missing directory would look like a missing binary.
        mkdirSync(this.workingDir, { recursive: true });
        child = spawn(this.binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: this.workingDir,
          env: distillEnv(),
        });
      } catch (cause) {
        reject(new RunnerError(RUNNER_ID, 'unavailable', `could not start ${this.binary}`, { cause }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() =>
          reject(new RunnerError(RUNNER_ID, 'timeout', `timed out after ${timeoutMs}ms`)),
        );
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(() => reject(new RunnerError(RUNNER_ID, 'timeout', 'cancelled')));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (cause) => {
        finish(() =>
          reject(
            new RunnerError(RUNNER_ID, 'unavailable', `${this.binary} could not be run`, { cause }),
          ),
        );
      });

      child.on('close', (code) => {
        finish(() => {
          if (code === 0) resolve(stdout.trim());
          else
            reject(
              new RunnerError(
                RUNNER_ID,
                'exit',
                `exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
              ),
            );
        });
      });

      child.stdin?.on('error', () => {
        // The process can exit before stdin drains. The close handler reports it.
      });
      child.stdin?.end(input);
    });
  }
}

/**
 * Pulls what a call cost out of the result envelope.
 *
 * Defensive throughout: this is another tool's output shape, and a missing
 * field should cost a number on a summary line, never a distillation.
 */
function readUsage(envelope: { usage?: unknown; total_cost_usd?: unknown }): RunUsage {
  const usage = (envelope.usage ?? {}) as Record<string, unknown>;
  const count = (key: string): number => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  return {
    inputTokens: count('input_tokens') + count('cache_creation_input_tokens'),
    cachedTokens: count('cache_read_input_tokens'),
    outputTokens: count('output_tokens'),
    costUsd:
      typeof envelope.total_cost_usd === 'number' && Number.isFinite(envelope.total_cost_usd)
        ? envelope.total_cost_usd
        : 0,
  };
}
