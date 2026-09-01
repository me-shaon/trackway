import { describeActor } from '../src/format.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_MARKER,
  ensureIgnoreRules,
  findRepoRoot,
  forgetCommand,
  hookCommand,
  ingestCommand,
  initCommand,
  hookTargets,
  installHook,
  isHookInstalled,
  loadWorkspace,
  persist,
  readConfig,
  readConfigResult,
  rejectedCommand,
  searchCommand,
  statusCommand,
  sessionsCommand,
  sweepReporter,
  syncCommand,
  acquireSyncLock,
  installGitHook,
  isGitHookInstalled,
  recordSweep,
  sweepIsDue,
  showCommand,
  whyCommand,
  writeConfig,
  type Io,
} from '../src/index.js';
import { TrackwayConfig, type MemoryRecord } from '@trackway/core';

const run = promisify(execFile);

let repo: string;
let previousCwd: string;

function captureIo(): Io & { lines: string[]; errors: string[]; statuses: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  return {
    lines,
    errors,
    statuses,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    status: (line) => statuses.push(line),
  };
}

function decisionRecord(overrides: Partial<Extract<MemoryRecord, { type: 'decision' }>> = {}) {
  return {
    id: 'dec-20260825-aaaaaaaa',
    type: 'decision' as const,
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    createdAt: '2026-08-25T09:18:00Z',
    significance: 'technical' as const,
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/ses-1.jsonl',
      fromOffset: 0,
      toOffset: 12,
    },
    question: 'Which cache should we use?',
    choice: 'Redis',
    reason: 'Already deployed here.',
    alternatives: [
      {
        choice: 'PostgreSQL unlogged tables',
        status: 'rejected' as const,
        reason: 'Higher latency for this workload.',
        condition: 'PostgreSQL is not deployed here',
      },
    ],
    attribution: {
      proposedBy: { type: 'agent' as const, id: 'agent:claude-code' },
      acceptedBy: { type: 'human' as const, id: 'human:local' },
    },
    status: 'accepted' as const,
    supersededBy: null,
    relationships: [],
    ...overrides,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'trackway-cli-'));
  await run('git', ['init', '-q'], { cwd: repo });
  previousCwd = process.cwd();
  process.chdir(repo);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(repo, { recursive: true, force: true });
});

describe('workspace', () => {
  it('finds the repository root from a subdirectory', async () => {
    const nested = join(repo, 'packages', 'core');
    await mkdir(nested, { recursive: true });

    const root = await findRepoRoot(nested);

    // macOS reports /private/var for /var, so compare the tail.
    expect(root?.endsWith(repo.replace('/private', ''))).toBe(true);
  });

  it('reports no workspace outside a git repository', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'trackway-loose-'));
    try {
      expect(await loadWorkspace(loose)).toBeNull();
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when no config has been written', async () => {
    expect(await readConfig(repo)).toEqual(TrackwayConfig.parse({}));
  });

  it('round-trips a config through disk', async () => {
    const config = TrackwayConfig.parse({ quietWindowMinutes: 42 });
    await writeConfig(join(repo, '.trackway'), config);

    expect((await readConfig(repo)).quietWindowMinutes).toBe(42);
  });

  it('prefills the project name from the repository directory at init', async () => {
    await initCommand({ hook: false }, captureIo());

    const raw = await readFile(join(repo, '.trackway', 'config.yml'), 'utf8');

    expect(raw).toContain(`projectName: ${basename(repo)}`);
    expect((await readConfig(repo)).projectName).toBe(basename(repo));
  });

  it('keeps the event cache outside the repository', async () => {
    const workspace = await loadWorkspace(repo);

    // A misconfigured ignore rule must not be able to commit parsed session
    // content, so the cache never lives inside the working tree.
    expect(workspace?.cacheDir.startsWith(repo)).toBe(false);
  });
});

describe('ignore rules', () => {
  it('ignores the index but leaves records tracked', async () => {
    const storeDir = join(repo, '.trackway');
    await ensureIgnoreRules(storeDir);
    await mkdir(join(storeDir, 'records'), { recursive: true });
    await writeFile(join(storeDir, 'index.sqlite'), 'binary', 'utf8');
    await writeFile(join(storeDir, 'records', 'dec-1.md'), '---\n---\n', 'utf8');

    const { stdout } = await run('git', ['status', '--porcelain', '--ignored'], { cwd: repo });

    // Records are the point of the product, so only the derived index is hidden.
    expect(stdout).toContain('!! .trackway/index.sqlite');
    expect(stdout).not.toContain('!! .trackway/records');
  });

  it('does not duplicate rules when run twice', async () => {
    const storeDir = join(repo, '.trackway');

    expect(await ensureIgnoreRules(storeDir)).toBe('created');
    expect(await ensureIgnoreRules(storeDir)).toBe('unchanged');

    const contents = await readFile(join(storeDir, '.gitignore'), 'utf8');
    expect(contents.match(/index\.sqlite\n/g)).toHaveLength(1);
  });

  it('appends to an ignore file that already has other rules', async () => {
    const storeDir = join(repo, '.trackway');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, '.gitignore'), 'scratch/\n', 'utf8');

    await ensureIgnoreRules(storeDir);
    const contents = await readFile(join(storeDir, '.gitignore'), 'utf8');

    expect(contents).toContain('scratch/');
    expect(contents).toContain('index.sqlite');
  });

  it('actually keeps git from tracking the index', async () => {
    const storeDir = join(repo, '.trackway');
    await ensureIgnoreRules(storeDir);
    await writeFile(join(storeDir, 'index.sqlite'), 'binary', 'utf8');

    const { stdout } = await run('git', ['status', '--porcelain', '--ignored'], { cwd: repo });

    expect(stdout).toContain('!! .trackway/index.sqlite');
  });
});

describe('hook installation', () => {
  it('writes a hook into user-level settings, not the repository', () => {
    const [target] = hookTargets('/home/dev');

    // User level is the point: one install covers every repository, including
    // ones that do not exist yet.
    expect(target?.settingsPath).toBe('/home/dev/.claude/settings.json');
  });

  it('installs into a settings file that does not exist yet', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);

    const result = await installHook(target!, hookCommand());

    expect(result.status).toBe('installed');
    expect(await isHookInstalled(target!)).toBe(true);
  });

  it('preserves settings that were already there', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      target!.settingsPath,
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [] }] } }),
      'utf8',
    );

    await installHook(target!, hookCommand());
    const settings = JSON.parse(await readFile(target!.settingsPath, 'utf8')) as Record<string, unknown>;

    expect(settings['model']).toBe('opus');
    expect((settings['hooks'] as Record<string, unknown>)['SessionStart']).toBeDefined();
    expect(JSON.stringify(settings)).toContain(HOOK_MARKER);
  });

  it('does not install twice', async () => {
    const home = join(repo, 'home');
    const [target] = hookTargets(home);

    await installHook(target!, hookCommand());
    const second = await installHook(target!, hookCommand());

    expect(second.status).toBe('already-present');
  });

  it('runs the sweep detached so it cannot block a session', () => {
    expect(hookCommand()).toContain('&');
    expect(hookCommand()).toContain('--quiet');
  });

  it('reports rather than throws when settings cannot be written', async () => {
    // A regular file cannot contain a directory, so writing through one fails
    // with ENOTDIR immediately, on every platform and for every user. The path
    // here used to be under /proc, which does not exist on macOS and is a live
    // kernel filesystem on Linux, so this passed locally and hung in CI.
    const blocker = join(repo, 'not-a-directory');
    await writeFile(blocker, '', 'utf8');

    const result = await installHook(
      { agent: 'claude-code', settingsPath: join(blocker, 'settings.json') },
      hookCommand(),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBeTruthy();
  });
});

describe('reading commands', () => {
  async function seed(records: MemoryRecord[]): Promise<void> {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, records);
  }

  it('finds a decision by text', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    const code = await searchCommand('Redis', { noSync: true }, io);

    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('dec-20260825-aaaaaaaa');
  });

  it('says so plainly when nothing matches', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await searchCommand('kubernetes', { noSync: true }, io);

    expect(io.lines.join('\n')).toContain('Nothing found');
  });

  it('finds a discarded option by text that appears only in the rejected branch', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand('unlogged', {}, io);
    const output = io.lines.join('\n');

    expect(output).toContain('PostgreSQL unlogged tables');
    expect(output).toContain('Higher latency');
    expect(output).toContain('instead: Redis');
  });

  it('shows the condition that made a rejection valid at the time', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand('unlogged', {}, io);

    expect(io.lines.join('\n')).toContain('PostgreSQL is not deployed here');
  });

  it('lists every discarded option when given no query', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await rejectedCommand(undefined, {}, io);

    expect(io.lines.join('\n')).toContain('PostgreSQL unlogged tables');
  });

  it('shows one record in full', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await showCommand('dec-20260825-aaaaaaaa', {}, io);
    const output = io.lines.join('\n');

    expect(output).toContain('Which cache should we use?');
    expect(output).toContain('Not taken:');
    expect(output).toContain('AGENT, YOU accepted');
  });

  it('reports a missing record with a non-zero exit', async () => {
    const io = captureIo();

    const code = await showCommand('dec-nope', {}, io);

    expect(code).toBe(1);
    expect(io.errors.join('\n')).toContain('No record with id');
  });

  it('emits parseable JSON when asked', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await searchCommand('Redis', { json: true, noSync: true }, io);

    expect(() => JSON.parse(io.lines.join('\n'))).not.toThrow();
  });

  it('names an agent decision taken without explicit approval', async () => {
    await seed([
      decisionRecord({
        attribution: {
          proposedBy: { type: 'agent', id: 'agent:claude-code' },
          acceptedBy: 'implicit',
        },
      }),
    ]);
    const io = captureIo();

    await showCommand('dec-20260825-aaaaaaaa', {}, io);

    expect(io.lines.join('\n')).toContain('no explicit approval');
  });

  it('groups records by session', async () => {
    await seed([decisionRecord()]);
    const io = captureIo();

    await sessionsCommand({}, io);

    expect(io.lines.join('\n')).toContain('ses-1');
  });
});

// Covers AE12.
describe('forget', () => {
  it('removes a record from disk and from search', async () => {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [decisionRecord()]);

    const io = captureIo();
    const code = await forgetCommand('dec-20260825-aaaaaaaa', {}, io);

    expect(code).toBe(0);

    const after = captureIo();
    await searchCommand('Redis', { noSync: true }, after);
    expect(after.lines.join('\n')).toContain('Nothing found');
  });

  it('reports a non-zero exit for an unknown id', async () => {
    const io = captureIo();

    expect(await forgetCommand('dec-nope', {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('No record with id');
  });

  it('removes every record from one session and leaves others', async () => {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [
      decisionRecord(),
      decisionRecord({ id: 'dec-20260825-bbbbbbbb', sessionId: 'ses-2', choice: 'Memcached' }),
    ]);

    const io = captureIo();
    await forgetCommand('ses-1', { session: true }, io);

    const after = captureIo();
    await searchCommand('Memcached', { noSync: true }, after);

    expect(io.lines.join('\n')).toContain('Removed 1 record');
    expect(after.lines.join('\n')).toContain('dec-20260825-bbbbbbbb');
  });
});

describe('commands outside a repository', () => {
  it('explain the problem rather than failing obscurely', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'trackway-loose-'));
    process.chdir(loose);

    try {
      const io = captureIo();
      const code = await searchCommand('anything', { noSync: true }, io);

      expect(code).toBe(1);
      expect(io.errors.join('\n')).toContain('Not inside a git repository');
    } finally {
      process.chdir(repo);
      await rm(loose, { recursive: true, force: true });
    }
  });
});

describe('an unusable config file', () => {
  it('reports why it was rejected instead of defaulting silently', async () => {
    // Found by using the tool: setting quietWindowMinutes to 0 fails validation,
    // the file was discarded, and the setting appeared to have no effect with
    // nothing said about it.
    const storeDir = join(repo, '.trackway');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: 0\n', 'utf8');

    const result = await readConfigResult(repo);

    expect(result.config.quietWindowMinutes).toBe(15);
    expect(result.problem).toContain('quietWindowMinutes');
    expect(result.problem).toContain('using defaults');
  });

  it('reports invalid YAML separately from an invalid value', async () => {
    const storeDir = join(repo, '.trackway');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindow: [unclosed\n', 'utf8');

    const result = await readConfigResult(repo);

    expect(result.problem).toContain('not valid YAML');
  });

  it('reports an unknown key rather than ignoring it', async () => {
    const storeDir = join(repo, '.trackway');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: 20\nverbose: true\n', 'utf8');

    const result = await readConfigResult(repo);

    // A typo in a key name would otherwise look like it worked.
    expect(result.problem).toBeTruthy();
  });

  it('says nothing when the config is valid', async () => {
    await writeConfig(join(repo, '.trackway'), TrackwayConfig.parse({ quietWindowMinutes: 20 }));

    const result = await readConfigResult(repo);

    expect(result.problem).toBeUndefined();
    expect(result.config.quietWindowMinutes).toBe(20);
  });

  it('says nothing when there is no config at all', async () => {
    const result = await readConfigResult(repo);

    expect(result.problem).toBeUndefined();
  });

  it('surfaces the problem through a command rather than hiding it', async () => {
    const storeDir = join(repo, '.trackway');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'config.yml'), 'quietWindowMinutes: -5\n', 'utf8');

    const io = captureIo();
    await searchCommand('anything', { noSync: true }, io);

    expect(io.errors.join('\n')).toContain('warning:');
  });
});

describe('when the index and the files disagree', () => {
  it('reports the drift rather than trusting the index', async () => {
    // Deleting a record file by hand leaves the index holding rows for records
    // that no longer exist. Status reported 197 records when 101 were on disk.
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [decisionRecord()]);
    await rm(join(workspace!.recordsDir, 'dec-20260825-aaaaaaaa.md'));

    const io = captureIo();
    await statusCommand({}, io);

    expect(io.lines.join('\n')).toContain('trackway rebuild');
  });

  it('says nothing when the index matches the files', async () => {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [decisionRecord()]);

    const io = captureIo();
    await statusCommand({}, io);

    expect(io.lines.join('\n')).not.toContain('trackway rebuild');
  });

  it('counts distinct records rather than write attempts', async () => {
    const workspace = await loadWorkspace(repo);

    // Two records that collapse onto one identity are one record, not two.
    const result = await persist(workspace!, [
      decisionRecord(),
      decisionRecord({ reason: 'A different reason for the same decision.' }),
    ]);

    expect(result.written).toBe(1);
  });
});

describe('naming people rather than saying "you"', () => {
  it('names the person who accepted, when the record knows one', () => {
    const named = decisionRecord({
      attribution: {
        proposedBy: { type: 'agent', id: 'agent:claude-code' },
        acceptedBy: { type: 'human', id: 'human:ada@example.com', name: 'Ada Lovelace' },
      },
    });

    expect(describeActor(named as MemoryRecord)).toBe('AGENT, Ada Lovelace accepted');
  });

  it('names the person who directed the work', () => {
    const named = decisionRecord({
      attribution: {
        proposedBy: { type: 'human', id: 'human:ada@example.com', name: 'Ada Lovelace' },
        acceptedBy: { type: 'human', id: 'human:ada@example.com', name: 'Ada Lovelace' },
      },
    });

    expect(describeActor(named as MemoryRecord)).toBe('Ada Lovelace');
  });

  it('falls back to "you" for records written before authorship existed', () => {
    expect(describeActor(decisionRecord() as MemoryRecord)).toBe('AGENT, YOU accepted');
  });
});

describe('tracing a line back to the decision behind it', () => {
  async function commitFile(name: string, body: string, message: string): Promise<string> {
    await writeFile(join(repo, name), body, 'utf8');
    await run('git', ['add', name], { cwd: repo });
    await run('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', message], { cwd: repo });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
    return stdout.trim();
  }

  async function seedLinked(sha: string, overrides = {}): Promise<void> {
    const workspace = await loadWorkspace(repo);
    await persist(workspace!, [
      decisionRecord({
        commits: [
          {
            sha,
            subject: 'add the cache',
            authoredAt: '2026-08-25T09:30:00Z',
            author: 'Ada',
            authorEmail: 'ada@example.com',
          },
        ],
        ...overrides,
      }) as MemoryRecord,
    ]);
  }

  it('answers with the decision that produced the line', async () => {
    const sha = await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    await seedLinked(sha);
    const io = captureIo();

    const code = await whyCommand('cache.ts', '1', {}, io);

    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('Which cache should we use?');
  });

  it('shows what was rejected, which is the point of asking', async () => {
    const sha = await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    await seedLinked(sha);
    const io = captureIo();

    await whyCommand('cache.ts', '1', {}, io);

    expect(io.lines.join('\n')).toContain('PostgreSQL unlogged tables');
  });

  it('covers the whole file when no line is given', async () => {
    const sha = await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    await seedLinked(sha);
    const io = captureIo();

    expect(await whyCommand('cache.ts', undefined, {}, io)).toBe(0);
  });

  it('hides working notes, and says how many it hid', async () => {
    const sha = await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    await seedLinked(sha, { significance: 'working' as const });
    const io = captureIo();

    const code = await whyCommand('cache.ts', '1', {}, io);

    expect(code).toBe(1);
    expect(io.errors.join('\n')).toContain('--all');
  });

  it('shows them when asked', async () => {
    const sha = await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    await seedLinked(sha, { significance: 'working' as const });
    const io = captureIo();

    expect(await whyCommand('cache.ts', '1', { all: true }, io)).toBe(0);
  });

  it('refuses a line number that is not one', async () => {
    await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    const io = captureIo();

    expect(await whyCommand('cache.ts', 'seven', {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('not a line number');
  });

  it('says the line is unattributable rather than pretending otherwise', async () => {
    await commitFile('other.ts', 'x\n', 'unrelated');
    await writeFile(join(repo, 'fresh.ts'), 'never committed\n', 'utf8');
    const io = captureIo();

    expect(await whyCommand('fresh.ts', '1', {}, io)).toBe(1);
    expect(io.errors.join('\n')).toMatch(/cannot attribute|no commits/i);
  });

  it('points at sync when the commit exists but nothing was distilled', async () => {
    await commitFile('cache.ts', 'const ttl = 60;\n', 'add the cache');
    const io = captureIo();

    expect(await whyCommand('cache.ts', '1', {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('trackway sync');
  });
});

describe('ingesting a transcript from an agent with no adapter', () => {
  const transcript = {
    agent: 'cursor',
    sessionId: 'composer-1',
    startedAt: '2026-08-27T10:00:00Z',
    entries: [{ role: 'user', text: 'Add rate limiting.' }],
  };

  it('refuses a file that is not JSON, saying so', async () => {
    await writeFile(join(repo, 'bad.json'), 'not json at all', 'utf8');
    const io = captureIo();

    expect(await ingestCommand(join(repo, 'bad.json'), {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('not JSON');
  });

  it('refuses an empty file rather than recording an empty session', async () => {
    await writeFile(join(repo, 'empty.json'), '   ', 'utf8');
    const io = captureIo();

    expect(await ingestCommand(join(repo, 'empty.json'), {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('empty');
  });

  it('names the field that is wrong, and points at the documented shape', async () => {
    await writeFile(
      join(repo, 'wrong.json'),
      JSON.stringify({ ...transcript, entries: [{ role: 'sorcerer', text: 'x' }] }),
      'utf8',
    );
    const io = captureIo();

    expect(await ingestCommand(join(repo, 'wrong.json'), {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('README');
  });

  it('says which file it could not read', async () => {
    const io = captureIo();

    expect(await ingestCommand(join(repo, 'absent.json'), {}, io)).toBe(1);
    expect(io.errors.join('\n')).toContain('absent.json');
  });
});

describe('reported version', () => {
  it('matches the version the package publishes', async () => {
    // The bundle takes its version from packages/cli/package.json while
    // `--version` prints a literal in bin.ts. Nothing forces the two to agree,
    // and v0.2.0 shipped only because this was caught by hand during release.
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(here, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const source = await readFile(join(here, '..', 'src', 'bin.ts'), 'utf8');

    const declared = /\.version\('([^']+)'\)/.exec(source)?.[1];
    expect(declared).toBe(manifest.version);
  });
});


describe('showing progress through a sync', () => {
  // A sync spends most of its time inside one model call that runs for
  // minutes. A line that only changes when a session finishes looks exactly
  // like a hang, gets killed, and the work is lost.
  it('says how many sessions there are before spending minutes on them', () => {
    const io = captureIo();

    sweepReporter(io).report({ phase: 'planned', discovered: 40, eligible: 12, deferred: 0 });

    expect(io.lines.join(' ')).toContain('12 session(s) to sync');
  });

  it('says plainly when there is nothing to do', () => {
    const io = captureIo();

    sweepReporter(io).report({ phase: 'planned', discovered: 40, eligible: 0, deferred: 0 });

    expect(io.lines.join(' ')).toContain('Nothing to sync');
  });

  it('names the sessions a cap left behind, so the backlog is not a surprise', () => {
    const io = captureIo();

    sweepReporter(io).report({ phase: 'planned', discovered: 40, eligible: 12, deferred: 7 });

    expect(io.lines.join(' ')).toContain('7 left for the next run');
  });

  it('counts done against total on the status line', () => {
    const io = captureIo();

    sweepReporter(io).report({
      phase: 'distilling',
      index: 3,
      total: 12,
      sessionId: 'abcdef0123456789',
      events: 842,
    });

    expect(io.statuses.join(' ')).toContain('[3/12] abcdef01');
    expect(io.statuses.join(' ')).toContain('842 events');
  });

  it('passes a note from inside the distiller straight through', () => {
    const io = captureIo();

    sweepReporter(io).report({
      phase: 'note',
      index: 1,
      total: 2,
      sessionId: 'abcdef0123456789',
      message: 'chunk 4 of 9',
    });

    expect(io.statuses.join(' ')).toContain('chunk 4 of 9');
  });

  // A status line is overwritten by the next session. A failure has to outlive
  // it or the run ends with no trace of what went wrong.
  it('keeps a failed session on screen rather than overwriting it', () => {
    const io = captureIo();

    sweepReporter(io).report({
      phase: 'done',
      index: 2,
      total: 4,
      sessionId: 'abcdef0123456789',
      records: 0,
      outcome: 'failed',
      reason: 'claude-code: could not start claude',
    });

    expect(io.errors.join(' ')).toContain('could not start claude');
    // Off a terminal the status line is a printed line too, so writing both
    // said it twice.
    expect(io.statuses.filter(Boolean)).toEqual([]);
  });

  it('clears the status line when the last session finishes', () => {
    const io = captureIo();

    sweepReporter(io).report({
      phase: 'done',
      index: 4,
      total: 4,
      sessionId: 'abcdef0123456789',
      records: 3,
      outcome: 'distilled',
    });

    expect(io.statuses.at(-1)).toBe('');
  });

  it('does not repeat a line that says the same thing, off a terminal', () => {
    const io = captureIo();
    const reporter = sweepReporter(io);

    const event = {
      phase: 'note',
      index: 1,
      total: 2,
      sessionId: 'abcdef0123456789',
      message: 'chunk 4 of 9',
    } as const;

    reporter.report(event);
    reporter.report(event);

    expect(io.statuses).toHaveLength(1);
  });
});

describe('the progress line on a terminal', () => {
  function terminalIo(): Io & { statuses: string[] } {
    const statuses: string[] = [];
    return {
      out: () => undefined,
      err: () => undefined,
      status: (line) => statuses.push(line),
      interactive: true,
      statuses,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a bar and a session count, not just the current session', () => {
    const io = terminalIo();
    const reporter = sweepReporter(io);

    reporter.report({ phase: 'planned', discovered: 40, eligible: 4, deferred: 0 });
    reporter.report({
      phase: 'done',
      index: 1,
      total: 4,
      sessionId: 'aaaaaaaa1111',
      records: 2,
      outcome: 'distilled',
    });
    reporter.report({ phase: 'reading', index: 2, total: 4, sessionId: 'bbbbbbbb2222', adapter: 'claude-code' });
    reporter.finish();

    const drawn = io.statuses.at(-2) ?? '';
    expect(drawn).toContain('1/4 sessions');
    expect(drawn).toContain('█');
    expect(drawn).toContain('░');
    expect(drawn).toContain('bbbbbbbb');
  });

  // The spinner is the part that says the process is alive during a model call
  // that reports nothing for minutes.
  it('keeps moving while nothing new is reported', () => {
    vi.useFakeTimers();

    const io = terminalIo();
    const reporter = sweepReporter(io, { frameMs: 50 });

    reporter.report({ phase: 'note', index: 1, total: 4, sessionId: 'aaaaaaaa1111', message: 'chunk 1 of 9' });
    const first = io.statuses.length;

    vi.advanceTimersByTime(200);

    expect(io.statuses.length).toBeGreaterThan(first);
    expect(new Set(io.statuses.map((line) => line.slice(0, 1))).size).toBeGreaterThan(1);

    reporter.finish();
  });

  it('stops animating once the sync is over', () => {
    vi.useFakeTimers();

    const io = terminalIo();
    const reporter = sweepReporter(io, { frameMs: 50 });

    reporter.report({ phase: 'note', index: 1, total: 4, sessionId: 'aaaaaaaa1111', message: 'chunk 1 of 9' });
    reporter.finish();

    const settled = io.statuses.length;
    vi.advanceTimersByTime(500);

    expect(io.statuses).toHaveLength(settled);
    expect(io.statuses.at(-1)).toBe('');
  });

  it('wipes the line before printing a failure under it', () => {
    const io = terminalIo();
    const reporter = sweepReporter(io);

    reporter.report({ phase: 'reading', index: 1, total: 2, sessionId: 'aaaaaaaa1111', adapter: 'claude-code' });
    reporter.report({
      phase: 'done',
      index: 1,
      total: 2,
      sessionId: 'aaaaaaaa1111',
      records: 0,
      outcome: 'failed',
      reason: 'claude-code: timed out',
    });
    reporter.finish();

    expect(io.statuses).toContain('');
  });
});

describe('sync in a repository with no sessions of its own', () => {
  it('says so and reports how long it took, rather than printing nothing', async () => {
    const io = captureIo();

    expect(await syncCommand({}, io)).toBe(0);
    expect(io.lines.join('\n')).toContain('Nothing to sync');
    expect(io.lines.join('\n')).toMatch(/Swept 0 session\(s\) in \d+s\./);
  });

  it('prints nothing at all when asked to be quiet, for the hook path', async () => {
    const io = captureIo();

    expect(await syncCommand({ quiet: true }, io)).toBe(0);
    expect([...io.lines, ...io.errors, ...io.statuses]).toEqual([]);
  });
});

describe('one sweep at a time', () => {
  /*
   * The hook fires when a session ends, and a developer with three windows
   * open ends three sessions. Without a lock each starts its own sweep over
   * the same sessions, spending the same model calls three times.
   */
  it('lets one caller hold the lock and turns the next away', async () => {
    const cacheDir = join(repo, 'cache');

    const first = acquireSyncLock(cacheDir);
    expect(first).not.toBeNull();
    expect(acquireSyncLock(cacheDir)).toBeNull();

    first?.release();
    const third = acquireSyncLock(cacheDir);
    expect(third).not.toBeNull();
    third?.release();
  });

  // A sweep that crashed must not stop every future one.
  it('takes over a lock whose owner is gone', async () => {
    const cacheDir = join(repo, 'cache');
    await mkdir(cacheDir, { recursive: true });

    // A pid that cannot be running, written as though a dead sweep left it.
    await writeFile(
      join(cacheDir, 'sync.lock'),
      JSON.stringify({ pid: 2147483, startedAt: new Date().toISOString() }),
      'utf8',
    );

    const lock = acquireSyncLock(cacheDir);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('does not take over a lock a live process holds', async () => {
    const cacheDir = join(repo, 'cache');
    await mkdir(cacheDir, { recursive: true });

    // This very process is alive, so its lock is real however old it looks.
    await writeFile(
      join(cacheDir, 'sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      'utf8',
    );

    expect(acquireSyncLock(cacheDir)).toBeNull();
  });
});

describe('a sync started from inside a distillation', () => {
  /*
   * The distill subprocess is an agent session, and ending one runs the
   * developer's hooks, including the hook that starts a sweep. On a real
   * machine this reached thirty-nine concurrent syncs in a few minutes.
   */
  it('refuses rather than recursing, and says so plainly', async () => {
    const io = captureIo();
    const previous = process.env.TRACKWAY_DISTILLING;
    process.env.TRACKWAY_DISTILLING = '1';

    try {
      expect(await syncCommand({}, io)).toBe(0);
      expect(io.lines.join(' ')).toContain('refusing to sweep recursively');
    } finally {
      if (previous === undefined) delete process.env.TRACKWAY_DISTILLING;
      else process.env.TRACKWAY_DISTILLING = previous;
    }
  });

  it('still prints nothing when quiet, which is how the hook runs it', async () => {
    const io = captureIo();
    const previous = process.env.TRACKWAY_DISTILLING;
    process.env.TRACKWAY_DISTILLING = '1';

    try {
      expect(await syncCommand({ quiet: true }, io)).toBe(0);
      expect([...io.lines, ...io.errors, ...io.statuses]).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TRACKWAY_DISTILLING;
      else process.env.TRACKWAY_DISTILLING = previous;
    }
  });
});

describe('syncing for agents that have no hook of their own', () => {
  /*
   * Claude Code is the only agent exposing a lifecycle hook. A repository
   * worked on entirely through Codex or OpenCode never synced by itself. A
   * commit is the agent-agnostic signal, and it is already the moment records
   * are linked to.
   */
  it('installs a post-commit hook where git actually looks for one', async () => {
    const result = await installGitHook(repo);

    expect(result.status).toBe('installed');
    expect(await isGitHookInstalled(repo)).toBe(true);

    const body = await readFile(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(body).toContain('trackway sync --quiet');
    expect(body.startsWith('#!')).toBe(true);
  });

  it('makes it executable, or git ignores it', async () => {
    await installGitHook(repo);
    const { mode } = await stat(join(repo, '.git', 'hooks', 'post-commit'));

    expect(mode & 0o111).not.toBe(0);
  });

  // A repository with a post-commit hook has it for a reason. Replacing it
  // would be the worst thing this could do.
  it('keeps a hook that is already there', async () => {
    const path = join(repo, '.git', 'hooks', 'post-commit');
    await writeFile(path, '#!/bin/sh\necho "existing hook"\n', { mode: 0o755 });

    const result = await installGitHook(repo);

    expect(result.status).toBe('appended');
    const body = await readFile(path, 'utf8');
    expect(body).toContain('echo "existing hook"');
    expect(body).toContain('trackway sync --quiet');
  });

  it('does not install itself twice', async () => {
    await installGitHook(repo);
    expect((await installGitHook(repo)).status).toBe('already-present');

    const body = await readFile(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(body.match(/trackway sync --quiet/g)).toHaveLength(1);
  });

  // Asked of git rather than assumed: a worktree puts hooks elsewhere, and a
  // repository using husky sets core.hooksPath. Writing to the wrong place
  // installs a hook that never runs and reports success.
  it('follows core.hooksPath rather than assuming .git/hooks', async () => {
    const custom = join(repo, '.husky');
    await mkdir(custom, { recursive: true });
    await run('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });

    const result = await installGitHook(repo);

    expect(result.path).toContain('.husky');
    expect(await readFile(join(custom, 'post-commit'), 'utf8')).toContain('trackway sync --quiet');
  });

  it('does not run trackway when it is not on the path', async () => {
    await installGitHook(repo);
    const body = await readFile(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');

    // A hook that errors on every commit for someone who uninstalled trackway
    // is worse than no hook.
    expect(body).toContain('command -v trackway');
  });
});

describe('not sweeping on every turn the agent finishes', () => {
  /*
   * The Stop hook fires each time the agent completes a turn, many times an
   * hour. Sweeping on every one meant the machine distilled continuously while
   * the developer worked, and a session that failed was retried from the top on
   * the very next turn.
   */
  it('is due when nothing has swept yet', () => {
    expect(sweepIsDue(join(repo, 'cache'), 10)).toBe(true);
  });

  it('is not due again straight away', () => {
    const cacheDir = join(repo, 'cache');
    const now = new Date('2026-08-31T12:00:00Z');

    recordSweep(cacheDir, now);

    expect(sweepIsDue(cacheDir, 10, new Date('2026-08-31T12:05:00Z'))).toBe(false);
    expect(sweepIsDue(cacheDir, 10, new Date('2026-08-31T12:11:00Z'))).toBe(true);
  });

  // Someone typing `trackway sync` asked for it now.
  it('is always due when the interval is switched off', () => {
    const cacheDir = join(repo, 'cache');
    recordSweep(cacheDir, new Date());

    expect(sweepIsDue(cacheDir, 0)).toBe(true);
  });

  it('holds the interval back from a hook-triggered run', async () => {
    const workspace = await loadWorkspace(repo);
    recordSweep(workspace!.cacheDir, new Date());

    const io = captureIo();
    expect(await syncCommand({ ifDue: true }, io)).toBe(0);
    expect(io.lines.join(' ')).toContain('swept recently');
  });

  it('lets a person run it whenever they like', async () => {
    const workspace = await loadWorkspace(repo);
    recordSweep(workspace!.cacheDir, new Date());

    const io = captureIo();
    await syncCommand({}, io);

    expect(io.lines.join(' ')).not.toContain('swept recently');
  });
});

describe('the command the agent hook runs', () => {
  it('is bounded and interval-aware, not a full sweep every turn', () => {
    expect(hookCommand()).toContain('--if-due');
    expect(hookCommand()).toContain('--max');
    expect(hookCommand()).toContain('--quiet');
    expect(hookCommand().trimEnd().endsWith('&')).toBe(true);
  });

  // The command is where the bounding lives, so leaving an old entry alone
  // meant a fix to the hook never reached anybody who already had one.
  it('replaces an entry left by an older version', async () => {
    const settingsPath = join(repo, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'trackway sync --quiet &' }] }] },
      }),
      'utf8',
    );

    const target = { agent: 'claude-code', settingsPath };
    expect((await installHook(target, hookCommand())).status).toBe('installed');

    const raw = await readFile(settingsPath, 'utf8');
    expect(raw).toContain('--if-due');
    expect(raw.match(/trackway sync/g)).toHaveLength(1);
  });

  it('leaves somebody else\'s Stop hook in place', async () => {
    const settingsPath = join(repo, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }),
      'utf8',
    );

    await installHook({ agent: 'claude-code', settingsPath }, hookCommand());

    const raw = await readFile(settingsPath, 'utf8');
    expect(raw).toContain('say done');
    expect(raw).toContain('trackway sync');
  });

  it('does not keep adding itself', async () => {
    const settingsPath = join(repo, 'settings.json');
    const target = { agent: 'claude-code', settingsPath };

    await installHook(target, hookCommand());
    expect((await installHook(target, hookCommand())).status).toBe('already-present');

    const raw = await readFile(settingsPath, 'utf8');
    expect(raw.match(/trackway sync/g)).toHaveLength(1);
  });
});

describe('running init again after an upgrade', () => {
  // Checking only whether a hook was present meant a fix to the hook command
  // never reached anybody who had already run init: the installer that knows
  // how to replace an old entry was never called.
  it('replaces a hook left by an older version', async () => {
    const settingsPath = join(repo, 'home', '.claude', 'settings.json');
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'trackway sync --quiet &' }] }] },
      }),
      'utf8',
    );

    const target = { agent: 'claude-code', settingsPath };
    expect(await isHookInstalled(target)).toBe(true);

    const result = await installHook(target, hookCommand());

    expect(result.status).toBe('installed');
    expect(await readFile(settingsPath, 'utf8')).toContain('--if-due');
  });
});
