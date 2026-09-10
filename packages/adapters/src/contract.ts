import type { MemoryEvent, SessionDescriptor } from '@trackway/core';

/**
 * What an adapter can do, declared rather than assumed.
 *
 * Agents differ. Claude Code exposes a non-interactive mode, so its sessions
 * can be distilled. Codex has no verified one here, so its sessions ingest and
 * index but stay undistilled. OpenCode redacts on the way out of its own CLI,
 * so running our redaction over it again would be wasted work.
 *
 * Callers branch on these flags, never on which adapter they hold.
 */
export interface AdapterCapabilities {
  /** The agent offers a non-interactive invocation usable for distillation. */
  canDistill: boolean;
  /** The agent redacts sensitive content itself, so our secret pass is redundant. */
  suppliesRedaction: boolean;
  /** The agent exposes a lifecycle hook that can trigger a sweep. */
  supportsHook: boolean;
}

export interface AdapterAvailability {
  available: boolean;
  /** Why not, when unavailable. Surfaced by `trackway status`. */
  reason?: string;
  /**
   * Where the adapter looked. Surfaced by `trackway status` so an empty result
   * can be told apart from a sweep of the wrong directory.
   */
  source?: string;
}

/**
 * One interface, two backing strategies.
 *
 * File-backed adapters read the agent's session files. CLI-backed adapters
 * shell out to the agent's own commands. Nothing above this line knows which,
 * which is what lets a fourth agent be added without touching core.
 */
export interface SessionAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  /** Cheap check. Never throws; a missing binary is an answer, not an error. */
  isAvailable(): Promise<AdapterAvailability>;

  /**
   * Session descriptors, without reading content. The sweep decides eligibility
   * from these alone, so this must stay cheap enough to run on every command.
   */
  listSessions(options?: ListOptions): Promise<SessionDescriptor[]>;

  /**
   * Parses one session into normalized events.
   *
   * Throws UnknownFormatError when the file shape is not recognized. Refusing
   * is the correct behaviour: guessing at an unfamiliar format writes wrong
   * records, and wrong records are worse than missing ones.
   */
  readSession(descriptor: SessionDescriptor, options?: ReadOptions): Promise<MemoryEvent[]>;
}

export interface ListOptions {
  /** Restricts to sessions whose working directory sits under this path. */
  repoRoot?: string;
}

export interface ReadOptions {
  /** Skips content at or before this offset, so a region is never re-read. */
  fromOffset?: number;
}

/** Raised when a session's shape does not match any known format version. */
export class UnknownFormatError extends Error {
  constructor(
    readonly adapterId: string,
    readonly sessionFile: string,
    readonly detail: string,
  ) {
    super(`${adapterId}: unrecognized session format in ${sessionFile} (${detail})`);
    this.name = 'UnknownFormatError';
  }
}

/** Raised when a session is recognized but cannot be read. */
export class SessionReadError extends Error {
  constructor(
    readonly adapterId: string,
    readonly sessionId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${adapterId}: ${message}`, options);
    this.name = 'SessionReadError';
  }
}
