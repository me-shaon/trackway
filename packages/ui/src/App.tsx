import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { api } from './api.js';
import { Caret, Check, Folder, Monitor, Moon, Search as SearchIcon, Sun } from './icons.js';
import { Rail } from './Rail.js';
import { applyTheme, readTheme, THEMES, type Theme } from './theme.js';
import { Decisions } from './views/Decisions.js';
import { History } from './views/History.js';
import { Search } from './views/Search.js';
import { Loading, Problem, Timeline, plural } from './views/Timeline.js';
import {
  kindOf,
  type Episode,
  type Forge,
  type MemoryRecord,
  type SessionSummary,
  type Significance,
} from './types.js';

type View = 'story' | 'decisions' | 'overview';

const LIT: Significance[] = ['business', 'technical', 'direction'];

/** What each theme is called, and what the icon for it is. */
const THEME_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const THEME_ICON: Record<Theme, ComponentType<{ size?: number }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * Chooses the ground the interface is drawn on.
 *
 * A list rather than a cycling button. Three states behind one button meant
 * two clicks to reach dusk from the default and no way to see what the
 * choices were without pressing it, which is the wrong trade for a control
 * someone touches once and then leaves alone.
 *
 * The open list is drawn by this page.
 */
function ThemeChoice(): ReactElement {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  // The inline script in the document has already applied a stored choice
  // before paint. This keeps the attribute in step with later changes.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!open) return;

    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && trigger.current?.closest('.theme')?.contains(event.target))
        return;
      setOpen(false);
    };

    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  useEffect(() => {
    if (open) items.current[THEMES.indexOf(theme)]?.focus();
  }, [open]);

  const choose = (next: Theme) => {
    setTheme(next);
    setOpen(false);
    trigger.current?.focus();
  };

  const step = (from: Theme, delta: number) => {
    const next = (THEMES.indexOf(from) + delta + THEMES.length) % THEMES.length;
    items.current[next]?.focus();
  };

  const Icon = THEME_ICON[theme];

  return (
    <div className="theme">
      <button
        ref={trigger}
        type="button"
        className="theme-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        // A button's accessible name is whatever is inside it, so on its own
        // this announced as "System" with no clue what it controls. The select
        // this replaced carried the purpose separately from the value; both
        // belong in the name here.
        aria-label={`Colour theme: ${THEME_LABEL[theme]}`}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (open && event.key === 'Escape') setOpen(false);
        }}
      >
        <Icon />
        <span>{THEME_LABEL[theme]}</span>
        <Caret size={11} />
      </button>

      {open && (
        <ul className="theme-menu" role="menu" aria-label="Colour theme">
          {THEMES.map((option, index) => {
            const OptionIcon = THEME_ICON[option];
            return (
              <li key={option} role="presentation">
                <button
                  ref={(element) => {
                    items.current[index] = element;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === theme}
                  tabIndex={-1}
                  onClick={() => choose(option)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      step(option, 1);
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      step(option, -1);
                    } else if (event.key === 'Escape') {
                      setOpen(false);
                      trigger.current?.focus();
                    }
                  }}
                >
                  <OptionIcon />
                  <span>{THEME_LABEL[option]}</span>
                  {option === theme ? <Check className="mark" size={13} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const TABS = [
  ['story', 'Story'],
  ['decisions', 'Decisions'],
  ['overview', 'Overview'],
] as const;

/**
 * One frame for every view.
 *
 * The rail and the reading column are the application's only structure, and
 * they do not change when the view does. Each view used to bring its own page
 * shape, so moving between them moved everything at once.
 */
export function App(): ReactElement {
  const [view, setView] = useState<View>('story');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [forge, setForge] = useState<Forge | undefined>(undefined);
  const [project, setProject] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<Set<Significance>>(new Set(LIT));
  const [topicId, setTopicId] = useState<string | null>(null);

  useEffect(() => {
    api.sessions().then((data) => setSessions(data.sessions)).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    setRecords(null);
    Promise.all([api.records(sessionId), api.overview()])
      .then(([r, o]) => {
        setRecords(r.records);
        setEpisodes(o.episodes);
        setForge(o.forge);
        setProject(o.project);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [sessionId]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { business: 0, technical: 0, direction: 0, working: 0 };
    for (const record of records ?? []) tally[kindOf(record)] = (tally[kindOf(record)] ?? 0) + 1;
    return tally;
  }, [records]);

  // Unticking a kind removes those records. The first version dimmed them in
  // place, which read as a rendering fault rather than a filter.
  const byKind = useMemo(
    () => (records ?? []).filter((record) => active.has(kindOf(record))),
    [records, active],
  );

  const visible = useMemo(
    () => byKind.filter((record) => topicId === null || record.episodeId === topicId),
    [byKind, topicId],
  );

  // Counted after the kind filters and before the topic filter, so each topic
  // reports what opening it would actually show.
  const topicCounts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const record of byKind) {
      const key = record.episodeId ?? '__ungrouped';
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [byKind]);

  const summary = useMemo(() => describe(records ?? [], sessions.length), [records, sessions]);

  // Typing in the search box is its own view. It replaces whatever is showing
  // and returns you where you were, so search never costs you your place.
  const searching = query.trim().length >= 2;

  // The tab says which project this explorer is reading.
  useEffect(() => {
    document.title = project ? `Trackway — ${project}` : 'Trackway';
  }, [project]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap">
          <div className="bar">
            <div className="wordmark">
              <h1>Trackway</h1>
              <p>Why your code is the way it is</p>
            </div>

            <div className="bar-end">
              <div className="omni">
              <SearchIcon />
              <input
                type="search"
                value={query}
                placeholder="Search decisions and discoveries"
                aria-label="Search decisions and discoveries"
                onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuery('');
                  }}
                />
              </div>

              <ThemeChoice />
            </div>
          </div>

          <div>
            {project ? (
              <div className="project" title="The project that's being explored">
                <Folder />
                <span>{project}</span>
              </div>
            ) : null}
            <nav className="tabs" aria-label="Views">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={!searching && view === id}
                  onClick={() => {
                    setQuery('');
                    setView(id);
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <div className="wrap split">
        <Rail
          counts={counts}
          topicCounts={topicCounts}
          matching={byKind.length}
          shown={visible.length}
          total={records?.length ?? 0}
          episodes={episodes}
          topicId={topicId}
          sessions={sessions}
          sessionId={sessionId}
          active={active}
          summary={summary}
          onToggleKind={(kind) => setActive(toggle(active, kind))}
          onPickTopic={setTopicId}
          onPickSession={setSessionId}
        />

        <main className="content">
          {error ? (
            <Problem detail={error} />
          ) : records === null ? (
            <Loading />
          ) : searching ? (
            <Search query={query} forge={forge} />
          ) : view === 'decisions' ? (
            <Decisions records={visible} all={records} forge={forge} />
          ) : view === 'overview' ? (
            <History
              records={records}
              visible={visible}
              episodes={episodes}
              sessions={sessions.length}
              onOpenTopic={(id) => {
                setTopicId(id);
                setView('story');
              }}
            />
          ) : (
            <Timeline
              records={records}
              visible={visible}
              episodes={episodes}
              topicId={topicId}
              forge={forge}
              onClearFilters={() => {
                setActive(new Set(LIT));
                setTopicId(null);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/** The project in one sentence, from the records themselves. */
function describe(records: readonly MemoryRecord[], sessionCount: number): string {
  if (records.length === 0) return 'Nothing recorded yet.';

  const decisions = records.filter((record) => record.type === 'decision');
  const kept = decisions.reduce(
    (n, record) => n + (record.type === 'decision' ? record.alternatives.length : 0),
    0,
  );
  const sessions = Math.max(1, sessionCount);

  return `${records.length} records from ${sessions} ${plural(sessions, 'session')}. ${
    decisions.length
  } ${plural(decisions.length, 'decision')}, holding ${kept} ${plural(
    kept,
    'option',
  )} that ${kept === 1 ? 'was' : 'were'} not taken.`;
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
