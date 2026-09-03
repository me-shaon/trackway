import type { MemoryRecord } from '@trackway/core';
import { z } from 'zod';
import type { DistillRunner } from './runner/contract.js';
import { extractJsonObject } from './runner/validate.js';

const Verdict = z.strictObject({ own: z.array(z.number().int().min(0)).default([]) });

/**
 * Separates facts about the world from notes about our own code.
 *
 * Discoveries are the noisiest record type. Most of what a build session
 * "discovers" is a bug in the thing being built, and the fix is already in the
 * code with a decision explaining it, so the discovery only repeats them. It
 * also duplicates: one bug found twice becomes two records that no lexical
 * comparison will merge, because they are worded differently.
 *
 * This runs as its own call rather than as part of the classification pass, and
 * that is the whole reason it works. The same rule written into the larger
 * prompt was ignored twice: 27 of 27 discoveries came back kept. Asked on its
 * own, with nothing else to weigh, the same model separates them 12 to 15.
 * One job per call.
 */
export async function triageDiscoveries(
  runner: DistillRunner,
  records: readonly MemoryRecord[],
  options: { onProblem?: (reason: string) => void } = {},
): Promise<MemoryRecord[]> {
  const discoveries = records.filter((record) => record.type === 'discovery');
  if (discoveries.length === 0) return [...records];

  // Nothing to demote. The extraction pass already marks a good share of
  // discoveries as working, and asking about a batch where every one is already
  // hidden costs a call to be told what we can see for ourselves.
  if (discoveries.every((record) => record.significance === 'working')) return [...records];

  let verdict: unknown;
  try {
    verdict = extractJsonObject(await runner.run(buildTriagePrompt(discoveries)));
  } catch {
    options.onProblem?.('discovery triage: the model returned no JSON object');
    return [...records];
  }

  const parsed = Verdict.safeParse(verdict);
  if (!parsed.success) {
    options.onProblem?.('discovery triage: the model returned JSON of the wrong shape');
    return [...records];
  }

  // Anything out of range is dropped rather than trusted, so a bad answer can
  // only leave records visible, never hide ones it never judged.
  const ownCode = new Set(parsed.data.own.filter((index) => index < discoveries.length));
  const demote = new Set(
    [...ownCode].map((index) => discoveries[index]?.id).filter((id): id is string => Boolean(id)),
  );

  return records.map((record) =>
    demote.has(record.id) ? { ...record, significance: 'working' as const } : record,
  );
}

export function buildTriagePrompt(discoveries: readonly MemoryRecord[]): string {
  const list = discoveries
    .map((record, index) => {
      const text = record.type === 'discovery' ? record.text : '';
      return `${index}. ${text.replace(/\s+/g, ' ')}`;
    })
    .join('\n');

  return `Each line below is a fact someone noted while building a tool.

Your only job: decide, for each, whether the fact is about THIS PROJECT'S OWN
CODE, or about something OUTSIDE it.

OWN CODE means a bug in the tool being built, how its own functions behave, a
field its own schema has, or how its own modules are arranged. The code already
holds this, so writing it down repeats the code.

OUTSIDE means another product's behaviour, the shape or scale of data found on
disk, a measured cost, or a general truth about a technique that would still
hold if this tool were rewritten from scratch.

The test: if the tool were deleted and rebuilt differently, would the fact still
be true and still worth knowing? If yes, it is OUTSIDE.

FACTS
${list}

Return ONLY this JSON, where "own" lists the indexes that are about this
project's own code:
{"own":[0,3,7]}`;
}
