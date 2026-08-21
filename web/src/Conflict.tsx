import { useMemo } from 'react';
import { changedOnly, countChanges, diffLines } from './diff';

/**
 * How many differing lines to list before saying there are more.
 *
 * A conflict with two hundred differing lines is not one anybody reads through
 * in a banner; the counts above the list are the useful part by then, and
 * "Keep both" is the answer regardless.
 */
const MAX_ROWS = 60;

export interface ConflictProps {
  /** What is in the editor, unsaved. */
  mine: string;
  /** What the server has, which the save was refused for. */
  theirs: string;
  onKeepMine(): void;
  onTakeTheirs(): void;
  onKeepBoth(): void;
}

/** "4 lines" / "1 line", so the sentence below reads either way. */
function lines(count: number): string {
  return count === 1 ? '1 line' : `${count} lines`;
}

/**
 * The save-conflict resolver.
 *
 * The banner this replaces named two versions and showed neither, which made
 * the decision blind — and worse, the button that sounded cautious ("Load
 * theirs") was the one that discarded your unsaved work. So this shows what
 * differs, says what each button destroys, and offers a third answer that
 * destroys nothing.
 */
export function Conflict({
  mine,
  theirs,
  onKeepMine,
  onTakeTheirs,
  onKeepBoth,
}: ConflictProps) {
  const changes = useMemo(() => diffLines(mine, theirs), [mine, theirs]);

  const counts = changes ? countChanges(changes) : null;
  const rows = changes ? changedOnly(changes) : [];
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div className="conflict" role="alert">
      <div className="conflict-head">
        <strong>This sheet changed on the server while you were editing.</strong>
        {counts ? (
          <span>
            Yours has {lines(counts.mine)} the server’s does not; the server’s has{' '}
            {lines(counts.theirs)} yours does not.
          </span>
        ) : (
          // The comparison is refused on very long sheets, so say the one true
          // thing left rather than implying the versions were examined.
          <span>
            Both versions are too long to compare here — yours is{' '}
            {lines(mine.split('\n').length)}, the server’s{' '}
            {lines(theirs.split('\n').length)}.
          </span>
        )}
      </div>

      {shown.length > 0 && (
        <ul className="conflict-diff">
          {shown.map((change, index) => (
            <li
              key={`${change.kind}-${change.line}-${index}`}
              className={`from-${change.kind}`}
            >
              <span className="conflict-mark" aria-hidden="true">
                {change.kind === 'mine' ? '−' : '+'}
              </span>
              <span className="conflict-where">
                {change.kind === 'mine' ? 'yours' : 'server'} {change.line}
              </span>
              <span className="conflict-text">{change.text || ' '}</span>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <p className="conflict-more">…and {lines(hidden)} more that differ.</p>
      )}

      <div className="conflict-actions">
        <button type="button" onClick={onKeepBoth}>
          Keep both
        </button>
        <button type="button" onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" onClick={onTakeTheirs}>
          Take the server’s
        </button>
        {/* Spelled out because the previous wording was the trap: "Load theirs"
            reads as the careful option and was the destructive one. */}
        <span className="conflict-hint">
          Keep both saves yours and copies the server’s into a new sheet. The other two
          discard one version.
        </span>
      </div>
    </div>
  );
}
