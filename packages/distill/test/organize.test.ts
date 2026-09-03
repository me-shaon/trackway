import type { MemoryRecord } from '@trackway/core';
import { describe, expect, it } from 'vitest';
import { organizeSession, type DistillRunner } from '../src/index.js';

function action(id: string, description: string): MemoryRecord {
  return {
    id,
    type: 'action',
    sessionId: 'ses-1',
    episodeId: null,
    commits: [],
    significance: 'working',
    createdAt: '2026-08-26T09:00:00Z',
    source: {
      adapter: 'claude-code',
      sessionId: 'ses-1',
      sessionFile: '/tmp/a.jsonl',
      fromOffset: 0,
      toOffset: 4,
    },
    description,
    status: 'completed',
    files: [],
  };
}

function stub(output: string): DistillRunner {
  return {
    id: 'stub',
    async isAvailable() {
      return { available: true };
    },
    async run() {
      return output;
    },
  };
}

const records = [action('a-1', 'Wrote the parser.'), action('a-2', 'Wrote its tests.')];

describe('grouping a session into topics', () => {
  it('assigns the topics the model returned', async () => {
    const result = await organizeSession(
      stub('{"episodes":[{"id":"ep-1","title":"Parser","recordIndexes":[0,1]}],"significance":{"0":"technical"}}'),
      records,
    );

    expect(result.episodes).toHaveLength(1);
    expect(result.records[0]?.episodeId).toBe('ep-1');
    expect(result.records[0]?.significance).toBe('technical');
  });

  /*
   * A real session of 132 records came back with 131 good classifications and
   * one word that is not one of the four. Strict parsing threw away every topic
   * in it, the call was paid for regardless, and the next run asked the same
   * question and rolled the same dice.
   */
  it('keeps the answer when one classification is not one of the four', async () => {
    const problems: string[] = [];

    const result = await organizeSession(
      stub('{"episodes":[{"id":"ep-1","title":"Parser","recordIndexes":[0,1]}],"significance":{"0":"technical","1":"unknown"}}'),
      records,
      { onProblem: (reason) => problems.push(reason) },
    );

    expect(result.episodes).toHaveLength(1);
    expect(result.records[0]?.significance).toBe('technical');
    // Dropped rather than trusted: the record keeps what extraction decided.
    expect(result.records[1]?.significance).toBe('working');
    expect(problems).toEqual([]);
  });

  it('drops a malformed topic and says how many it dropped', async () => {
    const problems: string[] = [];

    const result = await organizeSession(
      stub('{"episodes":[{"id":"ep-1","title":"Parser","recordIndexes":[0]},{"id":"","title":"","recordIndexes":[1]}],"significance":{}}'),
      records,
      { onProblem: (reason) => problems.push(reason) },
    );

    expect(result.episodes).toHaveLength(1);
    expect(problems.join(' ')).toContain('1 topic(s) came back malformed');
  });

  it('says so when the call came back with no JSON at all', async () => {
    const problems: string[] = [];

    const result = await organizeSession(stub('I could not do that.'), records, {
      onProblem: (reason) => problems.push(reason),
    });

    expect(result.episodes).toEqual([]);
    expect(problems.join(' ')).toContain('no JSON object');
  });
});
