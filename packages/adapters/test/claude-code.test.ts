import { MemoryEvent as MemoryEventSchema } from '@trackway/core';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeCodeAdapter,
  claudeProjectsDir,
  UnknownFormatError,
  containsReasoning,
  detectFormat,
  parseEntries,
  parseLines,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'claude-code');
const FIXTURE_SESSION = join(FIXTURES, '-fixture-repo', 'fixture-session-1.jsonl');

/** The fixture is a real session, anonymized, with two markers planted in it. */
const REASONING_SENTINEL = 'SENTINEL_REASONING_MUST_NOT_SURVIVE';
// A credential in a URL: the redactor catches it and no provider scanner
// claims the shape, so the fixture cannot block a push.
const SECRET_SENTINEL = 'https://ci-deploy:PLANTED-CREDENTIAL@internal.example.test/artifacts';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'trackway-cc-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function adapterOver(projectsDir: string) {
  return new ClaudeCodeAdapter({ projectsDir });
}

describe('parsing a real captured session', () => {
  it('parses the fixture into ordered normalized events', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();

    const events = await adapter.readSession(descriptor!);

    expect(events.length).toBeGreaterThan(0);
    const timestamps = events.map((e) => e.timestamp);
    expect([...timestamps].sort()).toEqual(timestamps);
  });

  it('produces events that validate against the shared schema', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();

    for (const event of await adapter.readSession(descriptor!)) {
      expect(() => MemoryEventSchema.parse(event)).not.toThrow();
    }
  });

  it('reports exactly one session per file', async () => {
    const adapter = adapterOver(FIXTURES);
    const descriptors = await adapter.listSessions();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.sessionId).toBe('fixture-session-1');
  });

  it('carries the working directory and branch into the descriptor', async () => {
    const [descriptor] = await adapterOver(FIXTURES).listSessions();

    expect(descriptor?.cwd).toBe('/Users/dev/fixture-repo');
    expect(descriptor?.branch).toBe('main');
  });

  it('separates a human prompt from tool output fed back to the model', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const prompts = events.filter((e) => e.type === 'user_prompt');
    const results = events.filter((e) => e.type === 'tool_result');

    expect(prompts.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    expect(prompts.every((e) => e.actor.type === 'human')).toBe(true);
    expect(results.every((e) => e.actor.type === 'agent')).toBe(true);
  });

  it('maps tool use to tool_call events attributed to the agent', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const calls = events.filter((e) => e.type === 'tool_call');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e) => e.actor.id === 'agent:claude-code')).toBe(true);
  });

  // Covers AE3.
  it('leaves no model reasoning anywhere in the parsed events', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const raw = await readFile(FIXTURE_SESSION, 'utf8');
    expect(raw).toContain(REASONING_SENTINEL); // the fixture really does contain it

    expect(JSON.stringify(events)).not.toContain(REASONING_SENTINEL);
    expect(events.some((e) => containsReasoning(e.payload))).toBe(false);
  });

  // Covers AE4.
  it('redacts credentials the agent read, before they reach an event', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const raw = await readFile(FIXTURE_SESSION, 'utf8');
    expect(raw).toContain(SECRET_SENTINEL); // planted in the fixture

    expect(JSON.stringify(events)).not.toContain(SECRET_SENTINEL);
  });

  it('resumes from an offset without re-emitting earlier events', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();

    const all = await adapter.readSession(descriptor!);
    const midpoint = all[Math.floor(all.length / 2)]!.source.offset;
    const tail = await adapter.readSession(descriptor!, { fromOffset: midpoint });

    expect(tail.every((e) => e.source.offset > midpoint)).toBe(true);
    expect(tail.length).toBeLessThan(all.length);
  });
});

describe('format detection', () => {
  it('refuses a file whose shape is not recognized', () => {
    const entries = [{ kind: 'something-else', data: 1 }];

    expect(() => detectFormat(entries, '/tmp/x.jsonl')).toThrow(UnknownFormatError);
  });

  it('refuses an empty file', () => {
    expect(() => detectFormat([], '/tmp/x.jsonl')).toThrow(UnknownFormatError);
  });

  it('names the file and the reason when refusing', () => {
    try {
      detectFormat([{ kind: 'nope' }], '/tmp/mystery.jsonl');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(String(error)).toContain('/tmp/mystery.jsonl');
      expect(String(error)).toContain('claude-code');
    }
  });

  it('accepts entries carrying the expected fields', () => {
    const entries = [{ type: 'user', uuid: 'a', message: { role: 'user', content: 'hi' } }];

    expect(detectFormat(entries, '/tmp/x.jsonl')).toContain('claude-code');
  });

  // Covers AE1.
  it('leaves already-ingested records untouched when a session is refused', async () => {
    const projects = join(scratch, 'projects', '-repo');
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, 'good.jsonl'), await readFile(FIXTURE_SESSION, 'utf8'));
    await writeFile(join(projects, 'alien.jsonl'), '{"kind":"from-the-future","v":9}\n');

    const descriptors = await adapterOver(join(scratch, 'projects')).listSessions();

    // The unfamiliar file is skipped; the recognizable one still lists.
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.sessionFile).toContain('good.jsonl');
  });
});

describe('damaged input', () => {
  it('parses every complete line and ignores a truncated final line', () => {
    const complete = '{"type":"user","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n';
    const truncated = `${complete}{"type":"assist`;

    const result = parseLines(truncated);

    expect(result.entries).toHaveLength(2);
    expect(result.truncatedTail).toBe(true);
  });

  it('skips a malformed line in the middle without losing the rest', () => {
    const contents = '{"type":"user","uuid":"a"}\nnot json at all\n{"type":"user","uuid":"c"}\n';

    const result = parseLines(contents);

    expect(result.entries).toHaveLength(2);
    expect(result.truncatedTail).toBe(false);
  });

  it('handles a file that is entirely blank lines', () => {
    expect(parseLines('\n\n\n').entries).toEqual([]);
  });
});

describe('subagent and meta traffic', () => {
  it('excludes sidechain entries, which belong to a different conversation', () => {
    const events = parseEntries(
      [
        { type: 'user', uuid: 'a', message: { role: 'user', content: 'main conversation' } },
        {
          type: 'user',
          uuid: 'b',
          isSidechain: true,
          message: { role: 'user', content: 'subagent conversation' },
        },
      ],
      { sessionFile: '/tmp/x.jsonl', sessionId: 'ses-1' },
    );

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('subagent conversation');
  });

  it('produces no event for a message that was only reasoning', () => {
    const events = parseEntries(
      [
        {
          type: 'assistant',
          uuid: 'a',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        },
      ],
      { sessionFile: '/tmp/x.jsonl', sessionId: 'ses-1' },
    );

    expect(events).toEqual([]);
  });
});

describe('availability', () => {
  it('reports unavailable when there is no session directory', async () => {
    const missing = join(scratch, 'nothing-here');
    const adapter = adapterOver(missing);

    const availability = await adapter.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no Claude Code session directory');
    // Naming the directory is the difference between "no sessions yet" and
    // "looking in the wrong tree", which otherwise read identically.
    expect(availability.reason).toContain(missing);
  });

  it('reports available when the directory exists, and says which one', async () => {
    expect(await adapterOver(FIXTURES).isAvailable()).toEqual({
      available: true,
      source: FIXTURES,
    });
  });

  it('filters sessions to the repository they ran in', async () => {
    const adapter = adapterOver(FIXTURES);

    const matching = await adapter.listSessions({ repoRoot: '/Users/dev/fixture-repo' });
    const elsewhere = await adapter.listSessions({ repoRoot: '/Users/dev/other-project' });

    expect(matching).toHaveLength(1);
    expect(elsewhere).toHaveLength(0);
  });
});

describe('behaviour discovered against the real session corpus', () => {
  it('excludes subagent transcript files entirely', async () => {
    const projects = join(scratch, 'projects', '-repo');
    await mkdir(projects, { recursive: true });
    const real = await readFile(FIXTURE_SESSION, 'utf8');
    await writeFile(join(projects, 'a0b1c2d3-main.jsonl'), real);
    await writeFile(join(projects, 'agent-a1267a02.jsonl'), real);

    const descriptors = await adapterOver(join(scratch, 'projects')).listSessions();

    // agent-*.jsonl is a subagent's own transcript. Its decisions belong to the
    // subagent's task, not the conversation the developer had.
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.sessionFile).toContain('a0b1c2d3-main.jsonl');
  });

  it('excludes sidechain entries inside a main session file', async () => {
    const adapter = adapterOver(FIXTURES);
    const [descriptor] = await adapter.listSessions();
    const events = await adapter.readSession(descriptor!);

    const raw = await readFile(FIXTURE_SESSION, 'utf8');
    expect(raw).toContain('SENTINEL_SUBAGENT_CONVERSATION');

    expect(JSON.stringify(events)).not.toContain('SENTINEL_SUBAGENT_CONVERSATION');
  });

  it('replaces inline image data with a marker instead of carrying base64', async () => {
    const events = parseEntries(
      [
        {
          type: 'user',
          uuid: 'a',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'look at this' },
              { type: 'image', source: { type: 'base64', data: 'A'.repeat(50_000) } },
            ],
          },
        },
      ],
      { sessionFile: '/tmp/x.jsonl', sessionId: 'ses-1' },
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('A'.repeat(1000));
    expect(serialized).toContain('"omitted":true');
    expect(serialized).toContain('look at this');
  });
});

describe('locating the session directory', () => {
  /** A config tree of the shape Claude Code writes, holding one real session. */
  async function configDirHoldingASession(name: string): Promise<string> {
    const config = join(scratch, name);
    const project = join(config, 'projects', '-fixture-repo');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'session.jsonl'), await readFile(FIXTURE_SESSION, 'utf8'));
    return config;
  }

  /**
   * A second Claude Code instance keeps its history under its own config
   * directory, and `claude` is told which one by CLAUDE_CONFIG_DIR. Reading the
   * same variable is what lets a sweep reach that instance without being
   * configured separately, and without it those sessions are invisible.
   */
  it('reads sessions from the config directory CLAUDE_CONFIG_DIR names', async () => {
    const config = await configDirHoldingASession('claude-elsewhere');
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);

    const sessions = await new ClaudeCodeAdapter().listSessions();

    expect(sessions).toHaveLength(1);
  });

  /** A fixture tree is asked for explicitly, so the environment cannot move it. */
  it('lets an explicit projectsDir win over the environment', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(scratch, 'claude-elsewhere'));

    const availability = await adapterOver(FIXTURES).isAvailable();

    expect(availability.source).toBe(FIXTURES);
  });

  /** The variable is how most machines are set up: unset. */
  it('falls back to the default tree when CLAUDE_CONFIG_DIR is not set', () => {
    expect(claudeProjectsDir({})).toBe(join(homedir(), '.claude', 'projects'));
  });

  /**
   * An exported-but-empty variable is a normal state of a shell profile, and
   * joining it would look in `/projects` at the root of the filesystem.
   */
  it('ignores a value that is only whitespace', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(
      join(homedir(), '.claude', 'projects'),
    );
  });

  /**
   * A tilde only survives into the value when it was quoted, which is easy to
   * do in a settings file where no shell is involved. Expanding it here is
   * cheaper than reporting a missing directory whose name contains a `~`.
   */
  it('expands a leading tilde', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '~/.claude-personal' })).toBe(
      join(homedir(), '.claude-personal', 'projects'),
    );
  });
});
