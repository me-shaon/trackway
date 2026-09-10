import type { SessionDescriptor } from '@trackway/core';
import type { ListOptions, SessionAdapter } from './contract.js';

export interface AdapterStatus {
  id: string;
  available: boolean;
  reason?: string;
  /** The directory or database the adapter reads, when it has one to report. */
  source?: string;
  canDistill: boolean;
}

export interface DiscoveredSession {
  descriptor: SessionDescriptor;
  adapter: SessionAdapter;
}

/**
 * Holds the adapters this run should consider.
 *
 * An adapter that reports unavailable is skipped rather than raising. A missing
 * agent binary is a normal state, not a failure: most machines will not have
 * all three installed.
 */
export class AdapterRegistry {
  private readonly adapters: SessionAdapter[];

  constructor(adapters: readonly SessionAdapter[]) {
    // Sorted so listing order does not depend on registration order.
    this.adapters = [...adapters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  all(): readonly SessionAdapter[] {
    return this.adapters;
  }

  get(id: string): SessionAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  /** Only the adapters whose agent is actually present on this machine. */
  async available(): Promise<SessionAdapter[]> {
    const checks = await Promise.all(
      this.adapters.map(async (adapter) => ({
        adapter,
        availability: await safeAvailability(adapter),
      })),
    );

    return checks.filter((entry) => entry.availability.available).map((entry) => entry.adapter);
  }

  /** What `trackway status` reports about each adapter. */
  async status(): Promise<AdapterStatus[]> {
    return Promise.all(
      this.adapters.map(async (adapter) => {
        const availability = await safeAvailability(adapter);
        return {
          id: adapter.id,
          available: availability.available,
          ...(availability.reason === undefined ? {} : { reason: availability.reason }),
          ...(availability.source === undefined ? {} : { source: availability.source }),
          canDistill: adapter.capabilities.canDistill,
        };
      }),
    );
  }

  /**
   * Every session across every available adapter.
   *
   * One adapter failing to list does not stop the others. A broken Codex
   * install must not prevent Claude Code sessions from being ingested.
   */
  async listAllSessions(options?: ListOptions): Promise<DiscoveredSession[]> {
    const found: DiscoveredSession[] = [];

    for (const adapter of await this.available()) {
      try {
        for (const descriptor of await adapter.listSessions(options)) {
          found.push({ descriptor, adapter });
        }
      } catch {
        // Skipped. Reported through status(), not raised here.
      }
    }

    return found.sort((a, b) =>
      a.descriptor.lastModified < b.descriptor.lastModified
        ? 1
        : a.descriptor.lastModified > b.descriptor.lastModified
          ? -1
          : 0,
    );
  }
}

async function safeAvailability(adapter: SessionAdapter) {
  try {
    return await adapter.isAvailable();
  } catch (error) {
    return { available: false, reason: `availability check failed: ${String(error)}` };
  }
}
