/**
 * A line-by-line comparison of two versions of a sheet.
 *
 * Its own module with its own tests because the conflict banner is the one
 * place in this app where being wrong costs someone their work. A diff that
 * misreported which lines differ would make the choice worse than no diff at
 * all — it would look like grounds for a decision while being none.
 */

export type ChangeKind = 'same' | 'mine' | 'theirs';

export interface Change {
  kind: ChangeKind;
  text: string;
  /** 1-based number of this line, in whichever version holds it. */
  line: number;
}

/**
 * How long a sheet can be before the comparison is abandoned.
 *
 * The table below is quadratic, so 1200 lines a side is about 6MB and a few
 * milliseconds. Sheets here are tens of lines; this exists so that a pasted
 * log file returns nothing instead of locking the tab, and the caller falls
 * back to reporting sizes.
 */
const MAX_LINES = 1200;

/**
 * The two versions reconciled, or null when they are too long to compare.
 *
 * Uses a longest common subsequence rather than comparing line 1 to line 1,
 * line 2 to line 2 and so on. That distinction is the whole value of the
 * thing: inserting a line at the top of a sheet changes one line, and a
 * positional comparison would report every line below it as changed too.
 */
export function diffLines(mine: string, theirs: string): Change[] | null {
  const a = mine.split('\n');
  const b = theirs.split('\n');
  const n = a.length;
  const m = b.length;
  if (n > MAX_LINES || m > MAX_LINES) return null;

  // table[i][j] is the length of the longest common subsequence of a[i:] and
  // b[j:]. Built from the end so the walk below can go forwards, which is the
  // order the lines have to come out in.
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      changes.push({ kind: 'same', text: a[i]!, line: i + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      changes.push({ kind: 'mine', text: a[i]!, line: i + 1 });
      i++;
    } else {
      changes.push({ kind: 'theirs', text: b[j]!, line: j + 1 });
      j++;
    }
  }
  while (i < n) changes.push({ kind: 'mine', text: a[i]!, line: ++i });
  while (j < m) changes.push({ kind: 'theirs', text: b[j]!, line: ++j });

  return changes;
}

/** How many lines each side has that the other does not. */
export function countChanges(changes: Change[]): { mine: number; theirs: number } {
  let mine = 0;
  let theirs = 0;
  for (const change of changes) {
    if (change.kind === 'mine') mine++;
    else if (change.kind === 'theirs') theirs++;
  }
  return { mine, theirs };
}

/**
 * The differing lines alone.
 *
 * Unchanged lines are dropped rather than shown greyed out: what is being
 * decided is what happens to the lines that differ, and on a long sheet the
 * handful that do would otherwise be lost among a hundred that do not.
 */
export function changedOnly(changes: Change[]): Change[] {
  return changes.filter((change) => change.kind !== 'same');
}
