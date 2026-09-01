/**
 * A progress line that moves on its own.
 *
 * A sync spends most of its time inside a single model call that can run for
 * minutes, so a line that only changes when something finishes is indis-
 * tinguishable from a hang for minutes at a time. The spinner is the part that
 * says the process is alive; the bar and the counts say how much of the work is
 * behind it and how much is ahead.
 */

/** Where a progress line goes. Structural, so an `Io` satisfies it as-is. */
export interface ProgressSink {
  status?: (line: string) => void;
  /** True when the sink is a terminal that can redraw a line in place. */
  interactive?: boolean;
}

export interface ProgressState {
  /** Sessions finished, for the bar. */
  completed: number;
  total: number;
  /** Which session is in hand, 1-based. */
  index: number;
  sessionId: string;
  /** What that session is doing right now. */
  activity: string;
}

export interface Progress {
  set(state: ProgressState): void;
  /** Wipes the line so a permanent message can be printed under it. */
  clear(): void;
  /** Stops animating and leaves the line clean. */
  stop(): void;
}

export interface ProgressOptions {
  frameMs?: number;
  barWidth?: number;
  now?: () => number;
}

/** Braille frames: one cell wide in every terminal font, unlike a block spinner. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const FRAME_MS = 90;
const BAR_WIDTH = 18;

/** A duration in the units a person waiting actually thinks in. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Token counts at the magnitude people quote them in. */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function bar(completed: number, total: number, width: number): string {
  const fraction = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  const filled = Math.round(fraction * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** Enough of a session id to tell two apart, which is all a progress line needs. */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function createProgress(sink: ProgressSink, options: ProgressOptions = {}): Progress {
  const now = options.now ?? (() => Date.now());
  const frameMs = options.frameMs ?? FRAME_MS;
  const barWidth = options.barWidth ?? BAR_WIDTH;

  // Without somewhere to redraw, animating would print a frame per tick and
  // bury the output it is meant to annotate.
  const animated = sink.interactive === true && sink.status !== undefined;

  const startedAt = now();
  let frame = 0;
  let state: ProgressState | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: string | null = null;

  const compose = (current: ProgressState): string => {
    const where = `[${current.index}/${current.total}]`;

    // Off a terminal every status is a line of its own in a log, so it carries
    // the counts itself and leaves out the parts that only mean something while
    // they are being redrawn.
    if (!animated) return `${where} ${shortId(current.sessionId)}  ${current.activity}`;

    const rest = [
      bar(current.completed, current.total, barWidth),
      `${current.completed}/${current.total} sessions`,
      shortId(current.sessionId),
      current.activity,
      formatDuration(now() - startedAt),
    ].join(' · ');

    // The spinner leads with a space, not a separator: it is the thing that is
    // moving, not another field.
    return `${FRAMES[frame % FRAMES.length]} ${rest}`;
  };

  const draw = (): void => {
    if (!state) return;
    const line = compose(state);

    // A log gets a line only when something it says has changed. A terminal
    // gets every frame, because the movement is the message.
    if (!animated && line === last) return;

    last = line;
    sink.status?.(line);
  };

  const startTicking = (): void => {
    if (!animated || timer !== null) return;
    timer = setInterval(() => {
      frame += 1;
      draw();
    }, frameMs);
    // Never a reason to hold the process open. The work being reported on is
    // what decides when this ends.
    timer.unref?.();
  };

  const stopTicking = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    set(next) {
      state = next;
      startTicking();
      draw();
    },

    clear() {
      last = null;
      sink.status?.('');
    },

    stop() {
      stopTicking();
      state = null;
      last = null;
      sink.status?.('');
    },
  };
}
