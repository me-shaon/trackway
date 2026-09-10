import type { EventType, MemoryEvent, SessionDescriptor } from '@trackway/core';
import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

const ADAPTER_ID = 'opencode';
export const OPENCODE_FORMAT_V1 = 'opencode/sqlite-v1';

export interface OpenCodeOptions {
  databasePath?: string;
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_updated: number | null;
}

interface PartRow {
  message_id: string;
  role: string;
  time_created: number | null;
  data: string;
}

/**
 * Reads OpenCode sessions from its local SQLite database.
 *
 * The CLI looked like the better path at first: `opencode export --sanitize`
 * hands back redacted JSON, which would have been redaction for free. It does
 * not work non-interactively. `opencode session list` writes nothing when
 * stdout is not a TTY, so sessions cannot be enumerated that way, and export
 * needs an id that enumeration would have supplied.
 *
 * Reading the database directly needs no binary, no TTY, and no subprocess.
 * The cost is that this is OpenCode's internal schema rather than a published
 * contract, so a missing table is treated as an unrecognized format and
 * refused rather than guessed at.
 */
export class OpenCodeAdapter implements SessionAdapter {
  readonly id = ADAPTER_ID;

  readonly capabilities: AdapterCapabilities = {
    // `opencode run` is non-interactive, so distillation is possible.
    canDistill: true,
    // Reading the database bypasses the CLI's --sanitize, so we redact.
    suppliesRedaction: false,
    supportsHook: false,
  };

  private readonly databasePath: string;

  constructor(options: OpenCodeOptions = {}) {
    this.databasePath =
      options.databasePath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  async isAvailable(): Promise<AdapterAvailability> {
    try {
      await stat(this.databasePath);
    } catch {
      return {
        available: false,
        reason: `no OpenCode database at ${this.databasePath}`,
        source: this.databasePath,
      };
    }

    try {
      const db = this.open();
      try {
        const tables = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>;
        const names = new Set(tables.map((row) => row.name));

        for (const required of ['session', 'message', 'part']) {
          if (!names.has(required)) {
            return { available: false, reason: `OpenCode database has no ${required} table` };
          }
        }
      } finally {
        db.close();
      }
    } catch (error) {
      return { available: false, reason: `OpenCode database unreadable: ${String(error)}` };
    }

    return { available: true, source: this.databasePath };
  }

  async listSessions(options: ListOptions = {}): Promise<SessionDescriptor[]> {
    const db = this.open();

    try {
      const rows = db
        .prepare(
          `SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC`,
        )
        .all() as SessionRow[];

      return rows
        .map((row) => ({
          sessionId: row.id,
          adapter: ADAPTER_ID,
          sessionFile: this.databasePath,
          cwd: row.directory,
          branch: null,
          lastModified: new Date(row.time_updated ?? 0).toISOString(),
          formatVersion: OPENCODE_FORMAT_V1,
        }))
        .filter((descriptor) => !options.repoRoot || underRoot(descriptor.cwd, options.repoRoot));
    } catch (cause) {
      throw new UnknownFormatError(ADAPTER_ID, this.databasePath, `session query failed: ${String(cause)}`);
    } finally {
      db.close();
    }
  }

  async readSession(
    descriptor: SessionDescriptor,
    options: ReadOptions = {},
  ): Promise<MemoryEvent[]> {
    const db = this.open();

    try {
      const rows = db
        .prepare(
          `SELECT p.message_id                        AS message_id,
                  json_extract(m.data, '$.role')      AS role,
                  p.time_created                      AS time_created,
                  p.data                              AS data
             FROM part p
             JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ?
            ORDER BY p.time_created ASC, p.id ASC`,
        )
        .all(descriptor.sessionId) as PartRow[];

      return toEvents(rows, descriptor, options.fromOffset ?? -1);
    } catch (cause) {
      throw new SessionReadError(ADAPTER_ID, descriptor.sessionId, 'could not read session parts', {
        cause,
      });
    } finally {
      db.close();
    }
  }

  private open(): Database.Database {
    // Read-only, so a sweep can never disturb a live OpenCode session.
    return new Database(this.databasePath, { readonly: true, fileMustExist: true });
  }
}

/**
 * Maps a part to an event kind.
 *
 * `reasoning` parts are dropped outright rather than sanitized downstream.
 * `step-start` and `step-finish` are turn bookkeeping with no content.
 */
function classify(partType: string, role: string): { type: EventType; actor: 'human' | 'agent' } | null {
  switch (partType) {
    case 'text':
      return role === 'user'
        ? { type: 'user_prompt', actor: 'human' }
        : { type: 'agent_message', actor: 'agent' };
    case 'tool':
      return { type: 'tool_call', actor: 'agent' };
    case 'patch':
    case 'file':
      return { type: 'file_change', actor: 'agent' };
    case 'reasoning':
    case 'step-start':
    case 'step-finish':
      return null;
    default:
      return null;
  }
}

function toEvents(
  rows: readonly PartRow[],
  descriptor: SessionDescriptor,
  fromOffset: number,
): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  let lastTimestamp = new Date(0).toISOString();

  rows.forEach((row, offset) => {
    if (offset <= fromOffset) return;

    let parsed: { type?: unknown };
    try {
      parsed = JSON.parse(row.data) as { type?: unknown };
    } catch {
      return;
    }

    const partType = typeof parsed.type === 'string' ? parsed.type : '';
    const mapped = classify(partType, row.role ?? 'assistant');
    if (!mapped) return;

    const timestamp = row.time_created ? new Date(row.time_created).toISOString() : lastTimestamp;
    lastTimestamp = timestamp;

    const { value } = sanitize(parsed);

    events.push({
      id: `${ADAPTER_ID}:${descriptor.sessionId}:${offset}`,
      sessionId: descriptor.sessionId,
      timestamp,
      type: mapped.type,
      actor:
        mapped.actor === 'human'
          ? { type: 'human', id: 'human:local' }
          : { type: 'agent', id: 'agent:opencode' },
      payload: value,
      source: { adapter: ADAPTER_ID, sessionFile: descriptor.sessionFile, offset },
    });
  });

  return events;
}

function underRoot(cwd: string | null, repoRoot: string): boolean {
  if (!cwd) return false;
  const root = resolve(repoRoot);
  const dir = resolve(cwd);
  return dir === root || dir.startsWith(`${root}/`);
}
