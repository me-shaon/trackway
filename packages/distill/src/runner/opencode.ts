import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { RunnerError, distillEnv, type DistillRunner, type RunOptions } from './contract.js';
import { runnerWorkingDir } from './claude.js';

const RUNNER_ID = 'opencode';

const DEFAULT_TIMEOUT_MS = 300_000;

export interface OpenCodeRunnerOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  workingDir?: string;
}

/**
 * Runs OpenCode non-interactively through `opencode run`.
 *
 * `--format json` emits one JSON object per line as the run progresses. The
 * answer is the concatenation of the `text` parts; everything else is
 * lifecycle. Parsing line by line and ignoring what we do not recognise means a
 * new event type is not a breaking change.
 *
 * `--pure` skips the developer's plugins, matching what the Claude runner does
 * with `--settings {}`: the extractor needs the model and the prompt, and
 * loading anything else is cost with no benefit.
 *
 * OpenCode has no equivalent of Codex's `--ephemeral`, so like Claude Code it
 * is run from a directory that belongs to no repository. The session it records
 * still exists; it just cannot be attributed to a repository and so is never
 * distilled back.
 */
export class OpenCodeDistillRunner implements DistillRunner {
  readonly id = RUNNER_ID;

  private readonly binary: string;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly workingDir: string;

  constructor(options: OpenCodeRunnerOptions = {}) {
    this.binary = options.binary ?? 'opencode';
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workingDir = options.workingDir ?? runnerWorkingDir();
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.exec(['--version'], '', 15_000);
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
      'run',
      '--format',
      'json',
      '--pure',
      ...(this.model ? ['--model', this.model] : []),
    ];

    const raw = await this.exec(args, prompt, options.timeoutMs ?? this.timeoutMs, options.signal);
    const text = collectText(raw);

    if (!text) {
      throw new RunnerError(RUNNER_ID, 'output', 'no text part in the event stream');
    }
    return text;
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
        mkdirSync(this.workingDir, { recursive: true });
        child = spawn(this.binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: this.workingDir,
          env: distillEnv(),
        });
      } catch (cause) {
        reject(
          new RunnerError(RUNNER_ID, 'unavailable', `could not start ${this.binary}`, { cause }),
        );
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
        finish(() => reject(new RunnerError(RUNNER_ID, 'timeout', `timed out after ${timeoutMs}ms`)));
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
        // The process can exit before stdin drains; close reports it.
      });
      child.stdin?.end(input);
    });
  }
}

/**
 * Pulls the assistant's words out of the event stream.
 *
 * Unrecognised lines are skipped rather than refused. This is OpenCode's own
 * event vocabulary, not a published contract, so a new event type should cost
 * nothing.
 */
export function collectText(raw: string): string {
  const parts: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: { type?: unknown; part?: { type?: unknown; text?: unknown } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }

    if (event.type === 'text' && typeof event.part?.text === 'string') {
      parts.push(event.part.text);
    }
  }

  return parts.join('').trim();
}
