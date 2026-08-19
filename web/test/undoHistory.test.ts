import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetUndoHistory,
  loadUndoHistory,
  saveUndoHistory,
} from '../src/undoHistory';

/** A stand-in for the browser's, with the same throwing behaviours. */
class FakeStorage {
  private entries = new Map<string, string>();
  /** Set to make writes fail, as an over-quota origin does. */
  full = false;

  get length(): number {
    return this.entries.size;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.full) throw new DOMException('quota', 'QuotaExceededError');
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('loadUndoHistory', () => {
  it('returns a stack kept against the document being opened', () => {
    saveUndoHistory('sheet-a', '2 + 2', { done: ['change'] });
    expect(loadUndoHistory('sheet-a', '2 + 2')).toEqual({ done: ['change'] });
  });

  it('returns nothing for a sheet that has none', () => {
    expect(loadUndoHistory('sheet-a', '2 + 2')).toBeNull();
  });

  /*
   * The safety property of the module. An undo is a change expressed in
   * positions, so one replayed over text it was not recorded against rewrites
   * the wrong span rather than failing — which is what would happen to a sheet
   * edited elsewhere while this tab was closed.
   */
  it('refuses a stack when the document changed since it was kept', () => {
    saveUndoHistory('sheet-a', '2 + 2', { done: ['change'] });
    expect(loadUndoHistory('sheet-a', '2 + 2\n3 + 3')).toBeNull();
  });

  /*
   * The editor asks speculatively: a sheet's id changes a render before its
   * text arrives, so the first ask carries the outgoing sheet's text and the
   * second the real one. Clearing on the refusal would destroy the stack that
   * second ask is coming back for, and the feature would never restore
   * anything.
   */
  it('leaves a refused stack in place for the ask that fits', () => {
    saveUndoHistory('sheet-a', '2 + 2', { done: ['change'] });
    expect(loadUndoHistory('sheet-a', 'text of the sheet being left')).toBeNull();
    expect(loadUndoHistory('sheet-a', '2 + 2')).toEqual({ done: ['change'] });
  });

  it('keeps one sheet answering for itself and not for another', () => {
    saveUndoHistory('sheet-a', 'a', { done: ['a'] });
    saveUndoHistory('sheet-b', 'b', { done: ['b'] });
    expect(loadUndoHistory('sheet-a', 'a')).toEqual({ done: ['a'] });
    expect(loadUndoHistory('sheet-b', 'b')).toEqual({ done: ['b'] });
  });

  it('takes the newer stack when a sheet is written twice', () => {
    saveUndoHistory('sheet-a', 'first', { done: ['1'] });
    saveUndoHistory('sheet-a', 'second', { done: ['2'] });
    expect(loadUndoHistory('sheet-a', 'first')).toBeNull();
    expect(loadUndoHistory('sheet-a', 'second')).toEqual({ done: ['2'] });
  });
});

describe('saveUndoHistory', () => {
  it('drops the least recently written once past the cap', () => {
    const now = vi.spyOn(Date, 'now');
    // Thirteen sheets against a cap of twelve, each written a tick after the last.
    for (let n = 0; n < 13; n++) {
      now.mockReturnValue(1000 + n);
      saveUndoHistory(`sheet-${n}`, `doc-${n}`, { done: [n] });
    }
    expect(loadUndoHistory('sheet-0', 'doc-0')).toBeNull();
    expect(loadUndoHistory('sheet-1', 'doc-1')).toEqual({ done: [1] });
    expect(loadUndoHistory('sheet-12', 'doc-12')).toEqual({ done: [12] });
  });

  it('refuses an entry too large to be worth keeping', () => {
    saveUndoHistory('sheet-a', 'small', { done: ['kept'] });
    // A pasted log file, whose stack would take the origin's whole quota.
    saveUndoHistory('sheet-a', 'x'.repeat(300_000), { done: ['huge'] });
    expect(loadUndoHistory('sheet-a', 'x'.repeat(300_000))).toBeNull();
    // And the entry it would have replaced is gone rather than left stale.
    expect(loadUndoHistory('sheet-a', 'small')).toBeNull();
  });

  it('says nothing when the origin refuses the write', () => {
    storage.full = true;
    expect(() => saveUndoHistory('sheet-a', 'doc', { done: [] })).not.toThrow();
    expect(loadUndoHistory('sheet-a', 'doc')).toBeNull();
  });
});

describe('forgetUndoHistory', () => {
  it('removes one sheet and leaves the rest', () => {
    saveUndoHistory('sheet-a', 'a', { done: ['a'] });
    saveUndoHistory('sheet-b', 'b', { done: ['b'] });
    forgetUndoHistory('sheet-a');
    expect(loadUndoHistory('sheet-a', 'a')).toBeNull();
    expect(loadUndoHistory('sheet-b', 'b')).toEqual({ done: ['b'] });
  });

  it('is quiet about a sheet that has none', () => {
    expect(() => forgetUndoHistory('sheet-a')).not.toThrow();
  });
});

describe('without usable storage', () => {
  it('reports no stack when the origin has no storage at all', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(loadUndoHistory('sheet-a', 'doc')).toBeNull();
    expect(() => saveUndoHistory('sheet-a', 'doc', { done: [] })).not.toThrow();
  });

  it('reports no stack when reading the origin throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
      configurable: true,
    });
    expect(loadUndoHistory('sheet-a', 'doc')).toBeNull();
  });

  it('starts over rather than trusting a half-written value', () => {
    storage.setItem('sumline.undo.v1', '{ not json');
    expect(loadUndoHistory('sheet-a', 'doc')).toBeNull();
    saveUndoHistory('sheet-a', 'doc', { done: ['fresh'] });
    expect(loadUndoHistory('sheet-a', 'doc')).toEqual({ done: ['fresh'] });
  });

  it('starts over rather than indexing into a value of the wrong shape', () => {
    storage.setItem('sumline.undo.v1', '["not", "an", "object"]');
    expect(loadUndoHistory('sheet-a', 'doc')).toBeNull();
  });
});
