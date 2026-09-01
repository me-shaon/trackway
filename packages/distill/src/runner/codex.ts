import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RunnerError, distillEnv, type DistillRunner, type RunOptions } from './contract.js';
import { runnerWorkingDir } from './claude.js';

const RUNNER_ID = 'codex';

/** Matches the Claude runner's limit, for the same reason: a chunk is a large request. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Where the Codex desktop app keeps its CLI.
 *
 * Codex ships as an application bundle rather than something on the PATH, so
 * looking only at the PATH reports it missing on a machine that has it. Both
 * are checked, PATH first, so an explicitly installed CLI still wins.
 */
export const CODEX_APP_BINARY = '/Applications/Codex.app/Contents/Resources/codex';

export interface CodexRunnerOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  workingDir?: string;
}

/**
 * Runs Codex non-interactively through `codex exec`.
 *
 * `--ephemeral` is the important flag. Every other agent writes a session file
 * for each invocation, which Trackway then discovers and distils, which writes
 * another one. Codex can simply be told not to persist, so its distillation
 * calls leave nothing behind at all.
 *
 * The final message is taken from `--output-last-message` rather than by
 * parsing the JSONL event stream: it is the one thing we want, written by the
 * tool for exactly this purpose, and it does not change shape between versions
 * the way an event stream does.
 */
export class CodexDistillRunner implements DistillRunner {
  readonly id = RUNNER_ID;

  private readonly binary: string;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly workingDir: string;

  constructor(options: CodexRunnerOptions = {}) {
    this.binary = options.binary ?? 'codex';
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workingDir = options.workingDir ?? runnerWorkingDir();
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    for (const candidate of this.candidates()) {
      try {
        await this.exec(candidate, ['--version'], '', 15_000);
        return { available: true };
      } catch {
        // Try the next location before concluding it is not installed.
      }
    }

    return { available: false, reason: 'no codex binary on the PATH or in /Applications' };
  }

  async run(prompt: string, options: RunOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    mkdirSync(this.workingDir, { recursive: true });

    // Written by Codex, read by us, removed either way. A file rather than
    // stdout because stdout carries the whole event stream.
    const outputPath = join(this.workingDir, `codex-${randomBytes(6).toString('hex')}.txt`);

    const args = [
      'exec',
      // Leaves no session behind, so distilling cannot feed itself.
      '--ephemeral',
      // Nothing from the developer's environment, matching the Claude runner.
      '--ignore-user-config',
      '--ignore-rules',
      // Extraction reads a prompt and writes JSON. It has no reason to touch
      // the filesystem, and the working directory is not a repository.
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
      ...(this.model ? ['--model', this.model] : []),
      // A bare `-` reads the prompt from stdin, which keeps a 40kB request off
      // the argument list.
      '-',
    ];

    let lastError: unknown;

    for (const candidate of this.candidates()) {
      try {
        await this.exec(candidate, args, prompt, timeoutMs, options.signal);

        const result = readFileSync(outputPath, 'utf8').trim();
        rmSync(outputPath, { force: true });

        if (!result) {
          throw new RunnerError(RUNNER_ID, 'output', 'codex wrote no final message');
        }
        return result;
      } catch (error) {
        lastError = error;
        rmSync(outputPath, { force: true });
        // Only a missing binary is worth trying the next location for. A real
        // failure means this install ran and did not work.
        if (!(error instanceof RunnerError) || error.kind !== 'unavailable') break;
      }
    }

    throw lastError ?? new RunnerError(RUNNER_ID, 'unavailable', 'codex could not be run');
  }

  private candidates(): string[] {
    return this.binary === 'codex' ? [this.binary, CODEX_APP_BINARY] : [this.binary];
  }

  private exec(
    binary: string,
    args: string[],
    input: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: this.workingDir,
          env: distillEnv(),
        });
      } catch (cause) {
        reject(new RunnerError(RUNNER_ID, 'unavailable', `could not start ${binary}`, { cause }));
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
          reject(new RunnerError(RUNNER_ID, 'unavailable', `${binary} could not be run`, { cause })),
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
