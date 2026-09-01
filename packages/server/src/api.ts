import {
  detectForge,
  effectiveSignificance,
  getRecord,
  isForeground,
  listRecords,
  listSessions,
  readEpisodes,
  search,
  searchAlternatives,
  type Episode,
  type IndexDatabase,
  type MemoryRecord,
  type Significance,
} from '@trackway/core';
import { Hono } from 'hono';

export interface ApiOptions {
  db: IndexDatabase;
  /** Where episodes.yml lives. Absent in tests that only exercise records. */
  storeDir?: string;
  /** Working tree the records describe, so commits can be linked to their forge. */
  repoRoot?: string;
  /** What the project is called. */
  projectName?: string;
}

export interface TimelineEntry {
  record: MemoryRecord;
  time: string;
}

export interface SessionTimeline {
  sessionId: string;
  entries: TimelineEntry[];
}

/**
 * The data API behind the explorer.
 *
 * Serves distilled records only. There is deliberately no endpoint that returns
 * raw events, so the explorer cannot render them as nodes even by accident, and
 * a session's full text never leaves the local process.
 */
export function createApi(options: ApiOptions): Hono {
  const app = new Hono();
  const { db } = options;

  const episodes = async (): Promise<Episode[]> =>
    options.storeDir ? readEpisodes(options.storeDir) : [];

  app.get('/api/sessions', (c) => c.json({ sessions: listSessions(db) }));

  /** Every record, optionally for one session, oldest first so it reads as a story. */
  app.get('/api/records', (c) => {
    const sessionId = c.req.query('session');
    const records = listRecords(db, {
      ...(sessionId ? { sessionId } : {}),
      limit: 5000,
    }).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    return c.json({ records });
  });

  app.get('/api/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    const records = listRecords(db, { sessionId, limit: 1000 });

    if (records.length === 0) {
      return c.json({ error: `No records for session ${sessionId}` }, 404);
    }

    const entries = [...records]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((record) => ({ record, time: record.createdAt.slice(11, 16) }));

    return c.json({ sessionId, entries } satisfies SessionTimeline);
  });

  app.get('/api/records/:id', (c) => {
    const record = getRecord(db, c.req.param('id'));
    return record ? c.json({ record }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/search', (c) => {
    const query = c.req.query('q') ?? '';
    const hits = search(db, query, { limit: 100 });
    return c.json({ query, records: hits.map((hit) => hit.record) });
  });

  app.get('/api/rejected', (c) => {
    const query = c.req.query('q');
    if (query) return c.json({ alternatives: searchAlternatives(db, query, { limit: 100 }) });

    const alternatives = listRecords(db, { types: ['decision'], limit: 500 }).flatMap((record) =>
      record.type === 'decision'
        ? record.alternatives.map((alternative) => ({
            ...alternative,
            decisionId: record.id,
            decisionChoice: record.choice,
            createdAt: record.createdAt,
            sessionId: record.sessionId,
          }))
        : [],
    );

    return c.json({ alternatives });
  });

  app.get('/api/decisions', (c) => {
    const actor = c.req.query('actor');
    const records = listRecords(db, {
      types: ['decision'],
      ...(actor === 'human' || actor === 'agent' ? { actor } : {}),
      limit: 2000,
    });

    // Project-level decisions first, then by recency. A reader opening the map
    // should land on something that mattered.
    const rank = (record: MemoryRecord) => (isForeground(record) ? 0 : 1);
    records.sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));

    return c.json({ records });
  });

  /** Everything the overview needs, in one request. */
  app.get('/api/overview', async (c) => {
    const sessions = listSessions(db);
    const all = listRecords(db, { limit: 5000 });
    const decisions = all.filter((record) => record.type === 'decision');

    const rejected = decisions.reduce(
      (total, record) => total + (record.type === 'decision' ? record.alternatives.length : 0),
      0,
    );

    const byKind: Record<Significance, number> = {
      business: 0,
      technical: 0,
      direction: 0,
      working: 0,
    };
    for (const record of all) byKind[effectiveSignificance(record)] += 1;

    const titles = await episodes();
    const grouped = titles
      .map((episode) => {
        const members = all.filter((record) => record.episodeId === episode.id);
        return {
          id: episode.id,
          title: episode.title,
          count: members.length,
          foreground: members.filter(isForeground).length,
          firstAt: members.reduce(
            (earliest, record) => (record.createdAt < earliest ? record.createdAt : earliest),
            members[0]?.createdAt ?? '',
          ),
        };
      })
      .filter((episode) => episode.count > 0)
      .sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1));

    // Resolved per request rather than stored on a record. A remote can be
    // added or moved long after a record is written, and a URL baked into the
    // record would then be wrong with nothing to correct it.
    const forge = options.repoRoot ? await detectForge(options.repoRoot) : null;

    return c.json({
      ...(options.projectName ? { project: options.projectName } : {}),
      ...(forge ? { forge: { host: forge.host, commitUrl: forge.commitUrl('COMMIT') } } : {}),
      sessions,
      episodes: grouped,
      byKind,
      counts: {
        sessions: sessions.length,
        records: all.length,
        decisions: decisions.length,
        rejected,
        foreground: all.filter(isForeground).length,
      },
    });
  });

  return app;
}
