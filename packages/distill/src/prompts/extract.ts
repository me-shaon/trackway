import type { MemoryEvent } from '@trackway/core';

/**
 * How much of each event reaches the model, by what kind of event it is.
 *
 * One budget for everything was wrong in both directions. Measured on a real
 * 2687-event session: tool results were 80% of the request, 499k characters of
 * command output and file dumps, while the developer's own words were 2.8%.
 * Decisions are in what people said, not in what `ls` printed.
 *
 * Tool results are capped hard rather than dropped, because a failing test or
 * an error message is exactly what an outcome record is made of. Their median
 * length is 217 characters, so the cap costs nothing on a typical one and only
 * bites on the tail: p99 is 11k and the largest seen was 46k.
 */
const TEXT_BUDGET: Record<MemoryEvent['type'], number> = {
  // What the developer asked for. The single most valuable thing here.
  user_prompt: 1600,
  // Where the agent states what it is doing and why.
  agent_message: 1400,
  // The command matters; its output is a separate event.
  tool_call: 500,
  // Capped hardest. See above.
  tool_result: 300,
  file_change: 300,
  error: 800,
  session_start: 200,
  session_end: 200,
};

/**
 * Kept from both ends of an oversized value, not just the start.
 *
 * A command that failed says so at the end as often as at the beginning:
 * stack traces, test summaries and non-zero exits all land in the tail. Keeping
 * only a prefix threw away the half that says whether it worked.
 */
const TAIL_SHARE = 0.35;

/**
 * The extraction prompt.
 *
 * Written for precision over volume. The failure mode that kills this product
 * is not missing a decision, it is filling someone's repository with records
 * they did not ask for and would not defend in review. So the instruction is
 * to skip aggressively, and to leave the batch empty when a session was routine
 * work.
 *
 * Attribution is spelled out because getting it wrong is worse than omitting
 * it: recording that a person approved something they never saw makes the whole
 * store untrustworthy.
 */
export const EXTRACTION_INSTRUCTIONS = `You extract durable engineering memory from a coding-agent session.

Return ONLY a JSON object. No prose before or after it, no markdown fences.

Shape:
{
  "questions":   [{ "significance": SIG, "question": str, "answer": null,
                    "status": "open",
                    "actor": { "type": "human"|"agent", "id": str } }],
  "discoveries": [{ "significance": SIG, "text": str }],
  "decisions":   [{ "significance": SIG, "question": str, "choice": str, "reason": str,
                    "alternatives": [{ "choice": str, "status": "rejected"|"considered",
                                       "reason": str, "condition": str|null }],
                    "attribution": { "proposedBy": { "type": ..., "id": str },
                                     "acceptedBy": { "type": ..., "id": str } | "implicit" } }],
  "actions":     [{ "significance": SIG, "description": str,
                    "status": "completed"|"partial"|"failed", "files": [str] }],
  "outcomes":    [{ "significance": SIG, "text": str,
                    "result": "passed"|"failed"|"unresolved" }]
}

SIG is one of "business" | "technical" | "direction" | "working".

WHAT TO RECORD

Record something only if a developer returning in six weeks would be helped by
it. Most of a session is not that. An empty array is the correct answer far more
often than a full one, and returning all five arrays empty is a valid response.

Record:
- Decisions where a real choice was made between options that mattered.
- Rejected alternatives, with WHY each was dropped. This is the most valuable
  thing you can capture. Commit history records what was built; nothing records
  what was considered and discarded.
- Discoveries, but only about things this project does not control: another
  tool's behaviour, the shape or scale of the data, a domain fact, a general
  truth about an approach. These survive a rewrite of this codebase.
- Questions ONLY when they were never resolved. A question that got answered
  is a decision, so record it as one with the answer as the choice. A record
  list full of answered questions sitting beside the decisions that answered
  them reads as unfinished work that is not actually unfinished.
- Actions only when they carry intent that the diff alone does not.
- Outcomes only when they resolve something that was genuinely in doubt.

Do NOT record:
- A question that was answered. Record the decision instead.
- Routine file reading, searching, or navigation.
- Restating what the code already says.
- Obvious next steps, or narration of what is about to happen.
- Trivial or mechanical choices: formatting, naming with no consequence,
  which of two equivalent helpers to call.
- The same decision more than once, however many times it was discussed.
- Anything you are inferring rather than observing. If the session does not
  show it, it did not happen.
- A bug found in this project's own code, or a note about how its own code
  behaves. The fix is in the code and the decision explains why, so the
  discovery only repeats them. These are the largest single source of noise.

SIGNIFICANCE

This is the most consequential field you set. It decides whether a record
appears in the project's history or in the agent's working notes, and getting
it wrong is what makes a record list unreadable.

"business" — what the product should do, for whom, and why. Product logic
decided or learned. It would still be true after a full rewrite.
  "Target businesses rather than developers, because developers do not pay
   for this and free incumbents already dominate."
  "Webhook delivery is not idempotent, so cancellation has to tolerate
   duplicates."

FOR A DISCOVERY, the test is where the fact lives. A fact about something
outside this codebase is business or technical. A fact about this codebase is
"working", however hard-won.

  keep (outside, survives a rewrite):
    "OpenCode moved its storage to SQLite; its CLI needs a terminal."
    "There are 344 session files on disk across three agents."
    "Word overlap cannot score a paraphrase; a correct one scored 0.06."
    "Agent hooks live in user settings, so one install covers every repo."

  working (our own code, where the fix is already the record):
    "Our identity hash included mutable fields, so superseding changed the id."
    "Our chunker capped at 200 events and silently dropped the rest."
    "The episodeId field was never populated by our distiller."
    "Our adapters use different backing strategies."

"technical" — an engineering choice that shapes the project. What to support,
which approach, what the architecture is. A developer would defend it in a
review, and someone new to the team needs to know it.
  "Read the agents' own session files rather than building live hooks."
  "Support three agents rather than one."

"direction" — an instruction the developer gave that steered the work. The
agent did not decide this; it was handed down. Record what was asked and why,
if a reason was given.
  "Do not gate the release on a precision score."
  "Test it against real data before shipping."

"working" — the agent's own detail while executing. Parse strategy, data
shapes, what goes in a hash, whether to stream or read whole, which regular
expression, how a function is named. Real work, and kept, but it belongs in
the working notes rather than the project's history.
  "Read only the head of the file instead of all of it."
  "Exclude the offset range from the identity hash."

Most of what a session produces is "working". Expect roughly two thirds.

Two tests, in order:
  1. Would someone who never opens this codebase still care? If yes, it is
     business or technical, never working.
  2. Did the developer ask for it rather than the agent choose it? If yes, it
     is direction.

When torn, choose "working". Wrongly promoting a detail buries the records
that matter, which costs more than wrongly demoting one.

CONDITIONS ON REJECTED OPTIONS

When an option was dropped for a reason that could stop being true, put that
reason in "condition" as a plain checkable statement.

  reason:    "Redis would be another service to run and we do not have one yet."
  condition: "Redis is not deployed in this project"

When the reason is a permanent property rather than a current circumstance,
leave condition null.

ATTRIBUTION

Getting this wrong is worse than leaving it out.

- The agent suggested and the person agreed → proposedBy agent, acceptedBy human.
- The person directed it → proposedBy human, acceptedBy human.
- The agent decided and simply proceeded, with no human response → acceptedBy
  MUST be the string "implicit". Never record a human acceptance that did not
  happen.
- Use "human:local" for the developer and "agent:<name>" for the agent.

REASONING

The session contains no model reasoning; it has been removed before you see it.
Do not reconstruct, infer, or invent it. Record only what was said and done.`;

export interface PromptInput {
  events: readonly MemoryEvent[];
  adapterId: string;
  /** Set when a session was split, so the model knows it is seeing a slice. */
  part?: { index: number; total: number };
  /** Forks already recorded verbatim, so the model does not restate them. */
  alreadyCaptured?: string;
}

/**
 * Renders events into the transcript the model reads.
 *
 * Each event is truncated. Whole tool outputs can run to tens of thousands of
 * characters, and the decision-bearing content is almost always near the start.
 */
/**
 * How much of a request one event will take up.
 *
 * Asked of the renderer rather than estimated, because events vary by orders of
 * magnitude and a guess is what put 91k characters into a chunk sized by count.
 */
export function renderedSize(event: MemoryEvent): number {
  return renderTranscript([event]).length + 2;
}

export function renderTranscript(events: readonly MemoryEvent[]): string {
  return events
    .map((event) => {
      const who = event.actor.type === 'human' ? 'DEVELOPER' : 'AGENT';
      return `[${event.type} | ${who}]\n${summarizePayload(event.payload, event.type)}`;
    })
    .join('\n\n');
}

function summarizePayload(payload: unknown, type: MemoryEvent['type']): string {
  const text = collectText(payload).join('\n').trim();
  if (text.length === 0) return '(no text content)';

  const budget = TEXT_BUDGET[type] ?? 1200;
  if (text.length <= budget) return text;

  const tail = Math.floor(budget * TAIL_SHARE);
  const head = budget - tail;

  return `${text.slice(0, head)}\n… (${text.length - budget} characters omitted) …\n${text.slice(-tail)}`;
}

/** Pulls human-readable strings out of an adapter-shaped payload. */
function collectText(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, depth + 1));

  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const interesting = ['text', 'content', 'message', 'command', 'description', 'output', 'name'];

    const found = interesting.flatMap((key) =>
      key in node ? collectText(node[key], depth + 1) : [],
    );

    return found.length > 0 ? found : [];
  }

  return [];
}

/**
 * The opening line of the extraction prompt, used to recognise our own output.
 *
 * Every distillation call is itself a coding-agent session, and the agent
 * records it like any other. Those sessions are then discovered and distilled,
 * which produces more of them. Running from a directory that belongs to no
 * repository stops new ones being attributed anywhere, but it cannot help the
 * ones already written, and re-reading those costs a model call each to learn
 * they contain nothing.
 *
 * Matching our own first line is exact rather than heuristic: the text is a
 * constant in this file, and a real session containing it verbatim would be one
 * discussing this extractor, which has nothing worth recording either.
 */
export const EXTRACTION_MARKER = EXTRACTION_INSTRUCTIONS.split('\n')[0] as string;

/**
 * True when these events are a distillation run rather than real work.
 *
 * The payload is adapter-shaped, so the text is found the same way the prompt
 * renderer finds it rather than by guessing at a key. Assuming `payload.text`
 * matched none of 151 real sessions, because Claude Code calls it `content`.
 */
export function isOwnExtraction(events: readonly MemoryEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'user_prompt' &&
      collectText(event.payload).some((text) => text.includes(EXTRACTION_MARKER)),
  );
}

export function buildPrompt(input: PromptInput): string {
  const transcript = renderTranscript(input.events);

  const partNote = input.part
    ? `\n\nThis is part ${input.part.index} of ${input.part.total} of one session. Record only what this part shows. Earlier and later parts are handled separately, so do not speculate about what came before or after.`
    : '';

  return `${EXTRACTION_INSTRUCTIONS}${partNote}${input.alreadyCaptured ?? ''}

SESSION TRANSCRIPT (agent: ${input.adapterId}, ${input.events.length} events)
---
${transcript}
---

Return the JSON object now.`;
}
