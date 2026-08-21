import { describe, expect, it } from 'vitest';
import { changedOnly, countChanges, diffLines } from '../src/diff';

/** The changed lines as `±text`, which is short enough to assert on directly. */
function changed(mine: string, theirs: string): string[] {
  const changes = diffLines(mine, theirs);
  if (!changes) throw new Error('expected a comparison');
  return changedOnly(changes).map(
    (change) => `${change.kind === 'mine' ? '-' : '+'}${change.text}`,
  );
}

describe('diffLines', () => {
  it('reports nothing when the versions agree', () => {
    const changes = diffLines('a\nb\nc', 'a\nb\nc');
    expect(changedOnly(changes!)).toEqual([]);
    expect(countChanges(changes!)).toEqual({ mine: 0, theirs: 0 });
  });

  it('reports a changed line as one line out and one line in', () => {
    expect(changed('rent = 1500', 'rent = 1650')).toEqual([
      '-rent = 1500',
      '+rent = 1650',
    ]);
  });

  /*
   * The reason this uses a longest common subsequence rather than comparing
   * line 1 to line 1. Inserting at the top shifts every line below it, and a
   * positional comparison would report the whole sheet as rewritten — which,
   * in a banner asking someone to pick a version, is a lie that costs work.
   */
  it('reads a line inserted at the top as one insertion, not a rewrite', () => {
    expect(changed('b\nc\nd', 'a\nb\nc\nd')).toEqual(['+a']);
  });

  it('reads a line removed from the middle as one removal', () => {
    expect(changed('a\nb\nc', 'a\nc')).toEqual(['-b']);
  });

  it('handles additions on both sides at once', () => {
    const result = changed('a\nmine\nc', 'a\ntheirs\nc');
    expect(result).toEqual(['-mine', '+theirs']);
    expect(countChanges(diffLines('a\nmine\nc', 'a\ntheirs\nc')!)).toEqual({
      mine: 1,
      theirs: 1,
    });
  });

  it('numbers lines against the version they belong to', () => {
    const changes = diffLines('a\nb', 'a\nx\nb')!;
    const inserted = changedOnly(changes)[0]!;
    // `x` is line 2 of theirs, though nothing sits at line 2 of mine.
    expect(inserted).toEqual({ kind: 'theirs', text: 'x', line: 2 });
  });

  it('treats an empty version as everything having been added', () => {
    expect(changed('', 'a\nb')).toEqual(['-', '+a', '+b']);
    expect(countChanges(diffLines('', 'a\nb')!)).toEqual({ mine: 1, theirs: 2 });
  });

  it('refuses a comparison too long to be worth making', () => {
    const huge = Array.from({ length: 1201 }, (_, i) => `line ${i}`).join('\n');
    expect(diffLines(huge, 'a')).toBeNull();
    expect(diffLines('a', huge)).toBeNull();
  });

  it('still compares a sheet at the limit', () => {
    const big = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    expect(diffLines(big, big)).not.toBeNull();
  });

  /* A trailing newline is a real line in a sheet, and dropping it would report
     a difference that editing never made. */
  it('counts a trailing newline as its own line', () => {
    expect(changed('a\n', 'a')).toEqual(['-']);
  });
});
