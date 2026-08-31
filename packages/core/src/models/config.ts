import { z } from 'zod';

export const DEFAULT_STORE_DIR = '.trackway';
export const DEFAULT_QUIET_WINDOW_MINUTES = 15;
export const DEFAULT_CACHE_RETENTION_DAYS = 30;

/**
 * How long the hook waits before sweeping again.
 *
 * The agent's Stop hook fires every time it finishes a turn, which is many
 * times an hour. Sweeping on each one meant the machine was distilling
 * continuously while the developer worked, and a session that failed was
 * retried from the top on the very next turn. A sweep is minutes of model
 * calls; it does not need to start again the moment it ends.
 */
export const DEFAULT_MIN_SYNC_INTERVAL_MINUTES = 10;

export const TrackwayConfig = z.strictObject({
  /** Repo-relative directory holding records. Tracked by git. */
  storePath: z.string().min(1).default(DEFAULT_STORE_DIR),

  /**
   * A session file untouched for this long is eligible for distillation.
   * A file still being written is never touched, so an active session never
   * contends with the developer's own agent.
   */
  quietWindowMinutes: z.number().int().positive().default(DEFAULT_QUIET_WINDOW_MINUTES),

  /** Raw parsed events are purged from the local cache after this many days. */
  cacheRetentionDays: z.number().int().positive().default(DEFAULT_CACHE_RETENTION_DAYS),

  /**
   * Least time between hook-triggered sweeps. Manual `trackway sync` ignores it.
   */
  minSyncIntervalMinutes: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_MIN_SYNC_INTERVAL_MINUTES),

  /** Adapter ids to run. An adapter reporting unavailable is skipped, not an error. */
  adapters: z.array(z.string().min(1)).default(['claude-code', 'codex', 'opencode']),
});

export type TrackwayConfig = z.infer<typeof TrackwayConfig>;

export function defaultConfig(): TrackwayConfig {
  return TrackwayConfig.parse({});
}
