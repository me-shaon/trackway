import { serve, type ServerType } from '@hono/node-server';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import type { IndexDatabase } from '@trackway/core';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { createApi } from './api.js';

export interface ExplorerOptions {
  db: IndexDatabase;
  storeDir?: string;
  repoRoot?: string;
  /** What the project is called. */
  projectName?: string;
  /** Directory holding the prebuilt explorer. */
  uiDir: string;
  port?: number;
  host?: string;
}

export interface RunningExplorer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function createExplorerApp(
  options: Pick<ExplorerOptions, 'db' | 'uiDir' | 'storeDir' | 'repoRoot' | 'projectName'>,
): Hono {
  const app = new Hono();

  // The records endpoint returns the whole store in one response, and record
  // text repeats heavily across a project's history. Measured on a 2020-record
  // store: 1.8 MB uncompressed, 55 KB gzipped.
  app.use('*', compress());

  app.route(
    '/',
    createApi({
      db: options.db,
      ...(options.storeDir ? { storeDir: options.storeDir } : {}),
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
      ...(options.projectName ? { projectName: options.projectName } : {}),
    }),
  );

  if (existsSync(options.uiDir)) {
    app.use('/assets/*', serveStatic({ root: options.uiDir }));
    // Fonts are served from this machine, not from a CDN, so the explorer keeps
    // its promise of opening with no network. Without this route they fell
    // through to the shell below and came back as HTML, and the interface lost
    // both typefaces without reporting anything.
    app.use('/fonts/*', serveStatic({ root: options.uiDir }));
    // Any non-API path serves the app shell, so a deep link still loads.
    app.get('*', serveStatic({ path: 'index.html', root: options.uiDir }));
  } else {
    app.get('*', (c) =>
      c.text('The explorer bundle is missing from this install. The API is still available.', 500),
    );
  }

  return app;
}

/**
 * Starts the explorer on the loopback interface only.
 *
 * Binding to localhost is a deliberate boundary rather than a default: the
 * records describe private work, and nothing about this needs to be reachable
 * from another machine.
 */
export async function startExplorer(options: ExplorerOptions): Promise<RunningExplorer> {
  const app = createExplorerApp(options);
  const host = options.host ?? '127.0.0.1';

  const server: ServerType = await new Promise((resolve) => {
    const instance = serve({ fetch: app.fetch, port: options.port ?? 7777, hostname: host }, () =>
      resolve(instance),
    );
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 7777);

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
