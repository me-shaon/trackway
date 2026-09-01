import type { ReactElement } from 'react';
import { RecordRow } from '../RecordRow.js';
import { FirstRun, plural } from './Timeline.js';
import type { DecisionRecord, Forge, MemoryRecord } from '../types.js';

/**
 * Every decision that came with a list of options, richest first.
 *
 * This used to be a two-pane picker with its own page shape, which made the
 * application look like three unrelated products. It renders the same rows as
 * the story and differs only in what it selects and how it orders: decisions
 * only, most options recorded first, ungrouped.
 */
interface Props {
  /** What the rail's filters leave. */
  records: MemoryRecord[];
  /** Every decision in the session, so the count says what it is a count of. */
  all: MemoryRecord[];
  forge?: Forge | undefined;
}

export function Decisions({ records, all, forge }: Props): ReactElement {
  const decisions = records
    .filter(isDecision)
    .sort((a, b) => b.alternatives.length - a.alternatives.length);
  const total = all.filter(isDecision).length;

  // Two different states: nothing captured yet, and nothing left after
  // filtering. One message for both told a first-time reader to adjust
  // filters they had never touched.
  if (all.length === 0) return <FirstRun />;

  if (decisions.length === 0) {
    return (
      <div className="empty">
        <h3>No decisions match these filters</h3>
        <p>
          {total === 0
            ? 'No decisions have been recorded in this session.'
            : `${total} ${plural(total, 'decision')} ${total === 1 ? 'is' : 'are'} recorded, but none of the kinds you ticked. Tick another kind on the left.`}
        </p>
      </div>
    );
  }

  const kept = decisions.reduce((n, decision) => n + decision.alternatives.length, 0);

  return (
    <>
      <p className="count">
        {decisions.length === total
          ? `All ${total} ${plural(total, 'decision')}`
          : `${decisions.length} of ${total} ${plural(total, 'decision')}`}
        , keeping {kept} {plural(kept, 'option')} that {kept === 1 ? 'was' : 'were'} not taken.
        Ordered by how many options each one recorded.
      </p>

      {decisions.map((decision) => (
        <RecordRow key={decision.id} record={decision} forge={forge} />
      ))}
    </>
  );
}

function isDecision(record: MemoryRecord): record is DecisionRecord {
  return record.type === 'decision';
}
