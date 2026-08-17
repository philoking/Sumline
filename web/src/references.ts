import {
  Annotation,
  EditorState,
  type Extension,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { isCommentLine } from './lines';

/**
 * Marks a document replacement that is not an edit.
 *
 * Switching sheets and adopting the server's copy after a conflict both swap
 * the whole document for an unrelated one. The renumbering below must sit that
 * out: mapping line 5 of one sheet onto another sheet is meaningless, and acting
 * on it would rewrite the arriving sheet using the outgoing one's answers.
 */
export const replacingDocument = Annotation.define<boolean>();

/** Set on the corrections this appends, so it cannot act on its own output. */
const renumbering = Annotation.define<boolean>();

/** `line N`, as the engine reads it. */
const REFERENCE_RE = /\bline\s*(\d+)\b/gi;

/**
 * Where a line of the old document ended up, or null if it did not survive.
 *
 * A line counts as gone when its text collapsed to nothing. Deleting the line
 * outright and emptying it both leave a reference with no value to read, so
 * there is no reason to tell them apart.
 */
function whereLineWent(
  tr: Transaction,
  before: Text,
  after: Text,
  number: number,
): number | null {
  const line = before.line(number);
  const from = tr.changes.mapPos(line.from, 1);
  const to = tr.changes.mapPos(line.to, -1);
  if (to < from || (line.length > 0 && to <= from)) return null;
  return after.lineAt(from).number;
}

/**
 * Keeps `line N` pointing at the line it was written against.
 *
 * References are positional, so inserting a line above one used to shift every
 * reference below it — silently, because the sheet still evaluated and only the
 * answers changed.
 *
 * The corrections are appended to the transaction that caused them, which is
 * what makes this a single undo step: one ⌘Z takes back both the insertion and
 * the rewriting it triggered.
 *
 * Three cases, and the third is why this corrects rather than resolves:
 *
 *  - the target moved — the number is corrected;
 *  - the target is gone — its last value is frozen in place, which is exactly
 *    what ⌘⇧U (unlink) does deliberately;
 *  - the target is gone and had no value — the token is left alone, because
 *    there is nothing truthful to put there.
 *
 * `prev` is deliberately untouched. It means "the line above" rather than one
 * particular line, so an insertion changes which line that is *correctly*.
 * Rewriting it to `line N` would swap a relative reference the user wrote for an
 * absolute one they did not.
 *
 * `lastAnswer` supplies a line's most recent answer, for the freezing case. It
 * is passed in rather than read from the editor because the answers live in
 * React state, and a transaction filter has no route to them.
 */
export function keepReferencesPointing(
  lastAnswer: (line: number) => string | null,
): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (tr.annotation(renumbering) || tr.annotation(replacingDocument)) return tr;

    const before = tr.startState.doc;
    const after = tr.newDoc;
    // Numbering only moves when the number of lines does, so an ordinary
    // keystroke never reaches the scan below. A single transaction that both
    // adds and removes a line nets out here and is missed; that comes from a
    // scripted multi-range edit rather than from typing, and leaves the
    // behaviour no worse than it was.
    if (before.lines === after.lines) return tr;

    const changes: Array<{ from: number; to: number; insert: string }> = [];

    for (let number = 1; number <= after.lines; number++) {
      const line = after.line(number);
      if (isCommentLine(line.text)) continue;

      for (const match of line.text.matchAll(REFERENCE_RE)) {
        // The text has not been renumbered yet, so this number still names a
        // line of the old document.
        const target = Number(match[1]);
        if (!Number.isInteger(target) || target < 1 || target > before.lines) {
          continue;
        }

        const moved = whereLineWent(tr, before, after, target);
        if (moved === target) continue;
        const insert = moved === null ? lastAnswer(target) : `line ${moved}`;
        if (insert === null) continue;

        const at = line.from + (match.index ?? 0);
        changes.push({ from: at, to: at + match[0].length, insert });
      }
    }

    if (changes.length === 0) return tr;
    return [tr, { changes, sequential: true, annotations: renumbering.of(true) }];
  });
}
