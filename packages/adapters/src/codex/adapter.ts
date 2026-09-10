import type { EventType, MemoryEvent, SessionDescriptor } from '@trackway/core';
import { createReadStream, type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  SessionReadError,
  UnknownFormatError,
  type AdapterAvailability,
  type AdapterCapabilities,
  type ListOptions,
  type ReadOptions,
  type SessionAdapter,
} from '../contract.js';
import { sanitize } from '../redact/index.js';

const ADAPTER_ID = 'codex';
export const CODEX_FORMAT_V1 = 'codex/rollout-jsonl-v1';

interface RawLine {
  type?: unknown;
  timestamp?: unknown;
  payload?: Record<string, unknown> | undefined;
}

export interface CodexOptions {
  sessionsDir?: string;
}

/**
 * Reads Codex rollout files.
 *
 * File-backed, like Claude Code, but with a different entry vocabulary:
 * session_meta, turn_context, response_item, and event_msg.
 *
 * Distils like any other adapter. This shipped disabled on the reasoning that
 * the Codex CLI could not be driven non-interactively, which was true and
 * beside the point: distillation runs the developer's own agent over the
 * events, and never invokes the agent that produced them. Nothing about a
 * Codex session needs Codex to read it.
 *
 * Verified before enabling, because the original caution was right that an
 * unexercised capability fails mid-sweep: a 28-event rollout distilled through
 * the real pipeline and produced valid records.
 */
export class CodexAdapter implements SessionAdapter {
  readonly id = ADAPTER_ID;

  readonly capabilities: AdapterCapabilities = {
    canDistill: true,
    suppliesRedaction: false,
    supportsHook: false,
  };

  private readonly sessionsDir: string;

  constructor(options: CodexOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
  }

  async isAvailable(): Promise<AdapterAvailability> {
    try {
      const info = await stat(this.sessionsDir);
      if (!info.isDirectory()) {
        return {
          available: false,
          reason: `${this.sessionsDir} is not a directory`,
          source: this.sessionsDir,
        };
      }
      return { available: true, source: this.sessionsDir };
    } catch {
      return {
        available: false,
        reason: `no Codex session directory at ${this.sessionsDir}`,
        source: this.sessionsDir,
      };
    }
  }

  async listSessions(options: ListOptions = {}): Promise<SessionDescriptor[]> {
    const files = await walkJsonl(this.sessionsDir);
    const descriptors: SessionDescriptor[] = [];

    for (const sessionFile of files) {
      const descriptor = await this.describe(sessionFile);
      if (!descriptor) continue;
      if (options.repoRoot && !underRoot(descriptor.cwd, options.repoRoot)) continue;
      descriptors.push(descriptor);
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
      throw new SessionReadError(ADAPTER_ID, descriptor.sessionId, 'could not read rollout file', {
        cause,
      });
    }

    const lines = parseJsonl(contents);
    assertKnownFormat(lines, descriptor.sessionFile);

    return toEvents(lines, descriptor, options.fromOffset ?? -1);
  }

  private async describe(sessionFile: string): Promise<SessionDescriptor | null> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(sessionFile);
    } catch {
      return null;
    }

    // Only the head is read. session_meta is the first line, and reading 137
    // rollout files in full on every command took a second of wall clock.
    const head = await readHeadLines(sessionFile, 20);
    if (head.length === 0) return null;

    const meta = head.find((line) => line.type === 'session_meta')?.payload;
    if (!meta) return null;

    try {
      assertKnownFormat(head, sessionFile);
    } catch {
      return null;
    }

    const git = meta.git as { branch?: unknown } | undefined;

    return {
      sessionId: typeof meta.id === 'string' ? meta.id : basename(sessionFile),
      adapter: ADAPTER_ID,
      sessionFile,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
      branch: typeof git?.branch === 'string' ? git.branch : null,
      lastModified: info.mtime.toISOString(),
      formatVersion: CODEX_FORMAT_V1,
    };
  }
}

const KNOWN_LINE_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg']);

function assertKnownFormat(lines: readonly RawLine[], sessionFile: string): void {
  if (lines.length === 0) {
    throw new UnknownFormatError(ADAPTER_ID, sessionFile, 'file contains no parseable entries');
  }

  if (!lines.some((line) => typeof line.type === 'string' && KNOWN_LINE_TYPES.has(line.type))) {
    const seen = [...new Set(lines.map((line) => String(line.type)))].slice(0, 5).join(', ');
    throw new UnknownFormatError(ADAPTER_ID, sessionFile, `no recognized entry types (saw: ${seen})`);
  }
}

function parseJsonl(contents: string): RawLine[] {
  const out: RawLine[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawLine);
    } catch {
      // Skipped. A partial final line is expected while a session is live.
    }
  }
  return out;
}

/**
 * Maps a rollout line to an event kind.
 *
 * `response_item:reasoning` is Codex's reasoning trace and is dropped here
 * rather than sanitized later, so it never becomes an event at all.
 *
 * `response_item:message` is skipped because user turns already arrive as
 * `event_msg:user_message`, and the remaining messages are system and developer
 * instructions rather than anything the developer said.
 */
function classify(line: RawLine): { type: EventType; actor: 'human' | 'agent' } | null {
  const payloadType = typeof line.payload?.type === 'string' ? line.payload.type : '';

  if (line.type === 'session_meta') return { type: 'session_start', actor: 'agent' };

  if (line.type === 'event_msg') {
    if (payloadType === 'user_message') return { type: 'user_prompt', actor: 'human' };
    if (payloadType === 'agent_message') return { type: 'agent_message', actor: 'agent' };
    if (payloadType === 'error') return { type: 'error', actor: 'agent' };
    return null;
  }

  if (line.type === 'response_item') {
    if (payloadType === 'function_call') return { type: 'tool_call', actor: 'agent' };
    if (payloadType === 'function_call_output') return { type: 'tool_result', actor: 'agent' };
    return null;
  }

  return null;
}

function toEvents(
  lines: readonly RawLine[],
  descriptor: SessionDescriptor,
  fromOffset: number,
): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  let lastTimestamp = new Date(0).toISOString();

  lines.forEach((line, offset) => {
    if (offset <= fromOffset) return;

    const mapped = classify(line);
    if (!mapped) return;

    const timestamp =
      typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp))
        ? new Date(line.timestamp).toISOString()
        : lastTimestamp;
    lastTimestamp = timestamp;

    const { value } = sanitize(line.payload);

    events.push({
      id: `${ADAPTER_ID}:${descriptor.sessionId}:${offset}`,
      sessionId: descriptor.sessionId,
      timestamp,
      type: mapped.type,
      actor:
        mapped.actor === 'human'
          ? { type: 'human', id: 'human:local' }
          : { type: 'agent', id: 'agent:codex' },
      payload: value,
      source: { adapter: ADAPTER_ID, sessionFile: descriptor.sessionFile, offset },
    });
  });

  return events;
}

/** Reads at most `limit` parsed lines from the start of a file. */
async function readHeadLines(path: string, limit: number): Promise<RawLine[]> {
  const out: RawLine[] = [];

  try {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          out.push(JSON.parse(trimmed) as RawLine);
        } catch {
          // Skipped.
        }
      }
      if (out.length >= limit) break;
    }

    lines.close();
    stream.destroy();
  } catch {
    return out;
  }

  return out;
}

/** Rollout files are nested by date, so the walk has to recurse. */
async function walkJsonl(root: string): Promise<string[]> {
  const found: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.jsonl')) found.push(path);
    }
  }

  await visit(root);
  return found;
}

function underRoot(cwd: string | null, repoRoot: string): boolean {
  if (!cwd) return false;
  const root = resolve(repoRoot);
  const dir = resolve(cwd);
  return dir === root || dir.startsWith(`${root}/`);
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.jsonl$/, '');
}
