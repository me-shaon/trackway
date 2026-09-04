import { DistillationResult, type MemoryRecord, flattenResult, withDerivedId } from '@trackway/core';
import { z } from 'zod';

/**
 * What the model is asked to return.
 *
 * Deliberately looser than the stored record: the model supplies content and
 * attribution, and everything derivable is filled in afterwards. Asking a model
 * to produce IDs, offsets, and timestamps invites it to invent them, and an
 * invented provenance field is worse than a missing one.
 */
const RawAlternative = z.strictObject({
  choice: z.string().min(1),
  status: z.enum(['rejected', 'considered']),
  reason: z.string().min(1),
  condition: z.string().nullable().default(null),
});

const RawActor = z.strictObject({
  type: z.enum(['human', 'agent']),
  id: z.string().min(1).default('unknown'),
});

/**
 * Models return acceptedBy as a bare string often enough that rejecting the
 * batch over it loses good records. Anything that is not an actor object and
 * not a recognisable actor string falls back to implicit, which is the honest
 * reading: no human acceptance was recorded.
 */
const RawAcceptance = z
  .union([
    RawActor,
    z.string().transform((value) => {
      const text = value.toLowerCase();
      if (text.startsWith('human')) return { type: 'human' as const, id: value };
      if (text.startsWith('agent')) return { type: 'agent' as const, id: value };
      return 'implicit' as const;
    }),
  ])
  // Anything else at all, null included, reads as implicit for the same reason.
  // Rejecting instead threw away every record in the batch and cost two more
  // calls retrying, to be told the same thing: one malformed field on one
  // decision was losing a whole chunk's work. Falling back can only ever
  // understate a human acceptance, never invent one, which is the direction
  // this file insists on everywhere else.
  .catch('implicit' as const);

/**
 * The same tolerance for who proposed something, falling back the safe way.
 *
 * Unreadable means agent, never human. Crediting a person with proposing
 * something they did not is the same class of error as recording an approval
 * they never gave, and this file refuses that everywhere else.
 */
const RawProposer = z
  .union([
    RawActor,
    z.string().transform((value) => {
      const text = value.toLowerCase();
      if (text.startsWith('human')) return { type: 'human' as const, id: value };
      return { type: 'agent' as const, id: value };
    }),
  ])
  .catch({ type: 'agent' as const, id: 'unknown' });

/**
 * The one envelope that drops keys it does not know rather than rejecting.
 *
 * A record carrying an invented field is rejected everywhere else in this file,
 * and that is on purpose: a model inventing fields is inventing content. This
 * envelope is different. It holds two references to who did what, both of which
 * already fall back rather than fail, and a model that adds "acceptedAt" beside
 * them has said nothing untrue about the decision.
 *
 * Measured on a real session: one such field cost the whole chunk, which was
 * reported as a region that could not be read and was re-read and paid for on
 * the next sync, where the same model was free to add the same field again.
 */
const RawAttribution = z.object({
  proposedBy: RawProposer,
  acceptedBy: RawAcceptance,
});

const RawSignificance = z
  .enum(['business', 'technical', 'direction', 'working'])
  .default('working');

export const RawDistillation = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        significance: RawSignificance,
        question: z.string().min(1),
        answer: z.string().nullable().default(null),
        status: z.enum(['open', 'resolved']),
        actor: RawActor,
      }),
    )
    .default([]),
  discoveries: z
    .array(z.strictObject({ significance: RawSignificance, text: z.string().min(1) }))
    .default([]),
  decisions: z
    .array(
      z.strictObject({
        significance: RawSignificance,
        question: z.string().min(1),
        choice: z.string().min(1),
        reason: z.string().min(1),
        alternatives: z.array(RawAlternative).default([]),
        attribution: RawAttribution,
      }),
    )
    .default([]),
  actions: z
    .array(
      z.strictObject({
        significance: RawSignificance,
        description: z.string().min(1),
        status: z.enum(['completed', 'partial', 'failed']),
        files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  outcomes: z
    .array(
      z.strictObject({
        significance: RawSignificance,
        text: z.string().min(1),
        /**
         * Models return an empty string here often enough that rejecting the
         * batch over it would throw away good records for a field that is a
         * label rather than content.
         */
        result: z
          .union([z.enum(['passed', 'failed', 'unresolved']), z.literal('')])
          .transform((value) => (value === '' ? ('unresolved' as const) : value)),
      }),
    )
    .default([]),
});

export type RawDistillation = z.infer<typeof RawDistillation>;

export class InvalidDistillationError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(`${message}: ${detail}`);
    this.name = 'InvalidDistillationError';
  }
}

export interface Provenance {
  sessionId: string;
  adapter: string;
  sessionFile: string;
  fromOffset: number;
  toOffset: number;
  createdAt: string;
}

/**
 * Pulls a JSON object out of model output.
 *
 * Models wrap JSON in prose or fences even when told not to. Recovering the
 * object is cheap; rejecting the whole batch because of a stray "Here is the
 * JSON:" would throw away real extraction for a formatting slip.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to brace matching.
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new InvalidDistillationError('no JSON object found in output', candidate.slice(0, 200));
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (cause) {
    throw new InvalidDistillationError('output was not valid JSON', String(cause).slice(0, 200));
  }
}

/**
 * Validates model output and turns it into records.
 *
 * The batch is rejected whole rather than partially accepted. A model that got
 * one record's shape wrong is not trustworthy for the rest of that response,
 * and half-written memory is harder to notice than none.
 */
export function toRecords(text: string, provenance: Provenance): MemoryRecord[] {
  const parsed = RawDistillation.safeParse(extractJsonObject(text));

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .slice(0, 5)
      .join('; ');
    throw new InvalidDistillationError('model output did not match the record schema', detail);
  }

  const source = {
    adapter: provenance.adapter,
    sessionId: provenance.sessionId,
    sessionFile: provenance.sessionFile,
    fromOffset: provenance.fromOffset,
    toOffset: provenance.toOffset,
  };

  const base = {
    sessionId: provenance.sessionId,
    episodeId: null,
    commits: [],
    createdAt: provenance.createdAt,
    source,
  };

  const raw = parsed.data;

  /*
   * An answered question is a decision that happened to be phrased as one.
   * Left as a question it sits beside the decision that answered it, and a
   * reader cannot tell resolved work from open work. Only genuinely open
   * questions stay questions.
   */
  const openQuestions = raw.questions.filter((q) => !q.answer || q.status === 'open');
  const answeredAsDecisions = raw.questions
    .filter((q) => q.answer && q.status === 'resolved')
    .map((q) => ({
      significance: q.significance,
      question: q.question,
      choice: q.answer as string,
      reason: 'Recorded as an answered question during the session.',
      alternatives: [],
      attribution: {
        proposedBy: q.actor,
        acceptedBy: (q.actor.type === 'human' ? q.actor : 'implicit') as
          | typeof q.actor
          | 'implicit',
      },
    }));

  const result = DistillationResult.parse({
    questions: openQuestions.map((q) =>
      withDerivedId({ ...base, type: 'question' as const, ...q, answer: null, status: 'open' as const }),
    ),
    discoveries: raw.discoveries.map((d) =>
      withDerivedId({ ...base, type: 'discovery' as const, ...d }),
    ),
    decisions: [...raw.decisions, ...answeredAsDecisions].map((d) =>
      withDerivedId({
        ...base,
        type: 'decision' as const,
        ...d,
        status: 'accepted' as const,
        supersededBy: null,
        relationships: [],
      }),
    ),
    actions: raw.actions.map((a) => withDerivedId({ ...base, type: 'action' as const, ...a })),
    outcomes: raw.outcomes.map((o) => withDerivedId({ ...base, type: 'outcome' as const, ...o })),
  });

  return flattenResult(result);
}
