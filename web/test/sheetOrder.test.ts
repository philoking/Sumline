import { describe, expect, it } from 'vitest';
import { reordered } from '../src/useSheetList';
import type { SheetSummary } from '../src/api';

/** Only the fields `reordered` reads; the rest is carried through untouched. */
function sheet(id: string, folderId: string | null = null): SheetSummary {
  return {
    id,
    title: id,
    version: 1,
    lines: 0,
    owner: 'me',
    color: null,
    folderId,
    deletedAt: null,
    createdAt: '',
    updatedAt: '',
  } as SheetSummary;
}

const ids = (list: SheetSummary[]): string[] => list.map((entry) => entry.id);

describe('the optimistic paint for a drag', () => {
  it('leaves every sheet outside the dragged group where it was', () => {
    // The whole of #131. A drag inside a folder sends that folder's ids and
    // nothing else, and this used to return exactly what it was given, so the
    // sidebar emptied of everything outside the folder until the server
    // answered. Two inside, two outside, and the two outside must not move.
    const list = [sheet('a', 'work'), sheet('b', 'work'), sheet('c'), sheet('d')];
    expect(ids(reordered(list, ['b', 'a']))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('puts the moved sheets back into the slots they already held', () => {
    // The same rule the server applies, so the optimistic paint and the answer
    // that replaces it agree. Interleaved on purpose: the moving sheets do not
    // have to be adjacent, and the ones between them stay put.
    const list = [sheet('a'), sheet('x'), sheet('b'), sheet('y'), sheet('c')];
    expect(ids(reordered(list, ['c', 'b', 'a']))).toEqual(['c', 'x', 'b', 'y', 'a']);
  });

  it('reorders the whole list when the whole list is dragged', () => {
    const list = [sheet('a'), sheet('b'), sheet('c')];
    expect(ids(reordered(list, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('ignores an id that is not in the list rather than dropping a row', () => {
    // A stale id from a sheet deleted in another browser mid-drag. The list
    // must come back the same length whatever arrives.
    const list = [sheet('a'), sheet('b')];
    expect(ids(reordered(list, ['b', 'ghost', 'a']))).toEqual(['b', 'a']);
  });

  it('returns the list unchanged when nothing was dragged', () => {
    const list = [sheet('a'), sheet('b')];
    expect(ids(reordered(list, []))).toEqual(['a', 'b']);
  });

  it('carries the rest of each sheet through untouched', () => {
    const list = [sheet('a', 'work'), sheet('b', 'work')];
    const [first] = reordered(list, ['b', 'a']);
    expect(first).toMatchObject({ id: 'b', folderId: 'work', version: 1 });
  });
});
