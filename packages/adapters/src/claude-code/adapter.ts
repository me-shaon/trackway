import type { MemoryEvent, SessionDescriptor } from '@trackway/core';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  SessionReadError,
  type AdapterAvailability,
  type AdapterCapabilities,
  type ListOptions,
  type ReadOptions,
  type SessionAdapter,
} from '../contract.js';
import { detectFormat, parseLines, type RawEntry } from './format.js';
import { claudeProjectsDir } from './paths.js';
import { parseEntries } from './parse.js';

const ADAPTER_ID = 'claude-code';

export interface ClaudeCodeOptions {
  /** Overridable so tests can point at a fixture tree. */
  projectsDir?: string;
}

/**
 * Reads Claude Code sessions from disk.
 *
 * File-backed. Nothing is hooked, nothing runs alongside the agent, and the
 * agent does not need to cooperate: it writes these files because resume
 * requires it.
 */
export class ClaudeCodeAdapter implements SessionAdapter {
  readonly id = ADAPTER_ID;

  readonly capabilities: AdapterCapabilities = {
    // `claude -p --output-format stream-json` runs non-interactively against
    // existing authentication, so distillation needs no second API key.
    canDistill: true,
    suppliesRedaction: false,
    // Hooks live in user-level settings, so installing one covers every repo.
    supportsHook: true,
  };

  private readonly projectsDir: string;

  constructor(options: ClaudeCodeOptions = {}) {
    this.projectsDir = options.projectsDir ?? claudeProjectsDir();
  }

  async isAvailable(): Promise<AdapterAvailability> {
    try {
      const info = await stat(this.projectsDir);
      if (!info.isDirectory()) {
        return {
          available: false,
          reason: `${this.projectsDir} is not a directory`,
          source: this.projectsDir,
        };
      }
      return { available: true, source: this.projectsDir };
    } catch {
      // Naming the directory, because the common failure is a relocated
      // instance whose sessions are real and sitting under another root.
      return {
        available: false,
        reason: `no Claude Code session directory at ${this.projectsDir}`,
        source: this.projectsDir,
      };
    }
  }

  async listSessions(options: ListOptions = {}): Promise<SessionDescriptor[]> {
    const projectDirs = await safeReaddir(this.projectsDir);
    const descriptors: SessionDescriptor[] = [];

    for (const projectDir of projectDirs) {
      const dirPath = join(this.projectsDir, projectDir);

      for (const name of await safeReaddir(dirPath)) {
        if (!name.endsWith('.jsonl')) continue;
        // agent-*.jsonl holds a subagent's own transcript. Its decisions belong
        // to that subagent's task, not to the conversation the developer had.
        if (name.startsWith('agent-')) continue;

        const sessionFile = join(dirPath, name);
        const descriptor = await this.describe(sessionFile);
        if (!descriptor) continue;

        if (options.repoRoot && !belongsToRepo(descriptor.cwd, options.repoRoot)) continue;
        descriptors.push(descriptor);
      }
    }

    return descriptors;
  }

  async readSession(
    descriptor: SessionDescriptor,
    options: ReadOptions = {},
  ): Promise<MemoryEvent[]> {
    let contents: string;
    try {
      contents = await readFile(descriptor.sessionFile, 'utf8');
    } catch (cause) {
      throw new SessionReadError(ADAPTER_ID, descriptor.sessionId, 'could not read session file', {
        cause,
      });
    }

    const { entries } = parseLines(contents);
    detectFormat(entries, descriptor.sessionFile);

    return parseEntries(entries, {
      sessionFile: descriptor.sessionFile,
      sessionId: descriptor.sessionId,
      ...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
    });
  }

  /**
   * Builds a descriptor without reading the whole file.
   *
   * Only the head is read, because the sweep calls this for every session on
   * every command and reading hundreds of multi-megabyte files would make the
   * CLI feel broken.
   */
  private async describe(sessionFile: string): Promise<SessionDescriptor | null> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(sessionFile);
    } catch {
      return null;
    }

    const head = await readHeadEntries(sessionFile, 40);
    if (head.length === 0) return null;

    const withSession = head.find((entry) => typeof entry.sessionId === 'string');
    const sessionId =
      typeof withSession?.sessionId === 'string'
        ? withSession.sessionId
        : basenameWithoutExtension(sessionFile);

    let formatVersion: string;
    try {
      formatVersion = detectFormat(head, sessionFile);
    } catch {
      // Unrecognized shape. Reported through the sweep, not raised here: one
      // unfamiliar file must not stop the rest from being listed.
      return null;
    }

    const withCwd = head.find((entry) => typeof entry.cwd === 'string');
    const withBranch = head.find((entry) => typeof entry.gitBranch === 'string');

    return {
      sessionId,
      adapter: ADAPTER_ID,
      sessionFile,
      cwd: typeof withCwd?.cwd === 'string' ? withCwd.cwd : null,
      branch: typeof withBranch?.gitBranch === 'string' ? withBranch.gitBranch : null,
      lastModified: info.mtime.toISOString(),
      formatVersion,
    };
  }
}

/** Reads at most `limit` entries from the start of a file. */
async function readHeadEntries(path: string, limit: number): Promise<RawEntry[]> {
  const entries: RawEntry[] = [];

  try {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        try {
          entries.push(JSON.parse(trimmed) as RawEntry);
        } catch {
          // Skipped; a damaged line near the head is not fatal.
        }
      }
      if (entries.length >= limit) break;
    }

    lines.close();
    stream.destroy();
  } catch {
    return entries;
  }

  return entries;
}

function belongsToRepo(cwd: string | null, repoRoot: string): boolean {
  if (!cwd) return false;
  const root = resolve(repoRoot);
  const dir = resolve(cwd);
  return dir === root || dir.startsWith(`${root}/`);
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

function basenameWithoutExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.jsonl$/, '');
}
