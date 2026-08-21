import { describe, expect, it } from 'vitest';
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { keepReferencesPointing, replacingDocument } from '../src/references';

/**
 * The renumbering is driven through real transactions rather than called
 * directly, because what it has to get right is the interaction with
 * CodeMirror's change mapping — which is the part a unit test of the helper
 * would skip.
 */
function sheet(doc: string, lastAnswer: (line: number) => string | null = () => null) {
  const extensions: Extension = keepReferencesPointing(lastAnswer);
  return EditorState.create({ doc, extensions });
}

/** Applies a change and returns the resulting document. */
function after(state: EditorState, spec: TransactionSpec): string {
  return state.update(spec).state.doc.toString();
}

describe('a line inserted above a reference', () => {
  it('renumbers the reference so it points at the same line', () => {
    // `line 1` is the "100" on the first line.
    const state = sheet('100\nline 1 + 5');
    // A new first line pushes the 100 down to line 2.
    expect(after(state, { changes: { from: 0, insert: 'heading\n' } })).toBe(
      'heading\n100\nline 2 + 5',
    );
  });

  it('renumbers every reference below the insertion', () => {
    const state = sheet('10\n20\nline 1 + line 2');
    expect(after(state, { changes: { from: 0, insert: 'x\n' } })).toBe(
      'x\n10\n20\nline 2 + line 3',
    );
  });

  it('leaves references alone when the insertion is below them', () => {
    const state = sheet('100\nline 1 + 5');
    const end = state.doc.length;
    expect(after(state, { changes: { from: end, insert: '\ntrailing' } })).toBe(
      '100\nline 1 + 5\ntrailing',
    );
  });

  it('leaves everything alone when no line was added or removed', () => {
    const state = sheet('100\nline 1 + 5');
    expect(after(state, { changes: { from: 3, insert: '0' } })).toBe('1000\nline 1 + 5');
  });
});

describe('a line removed above a reference', () => {
  it('renumbers the reference downwards', () => {
    const state = sheet('x\n100\nline 2 + 5');
    // Drop the first line, including its newline.
    expect(after(state, { changes: { from: 0, to: 2 } })).toBe('100\nline 1 + 5');
  });
});

describe('when the referenced line itself is deleted', () => {
  it('freezes the reference at that line’s last answer', () => {
    // What ⌘⇧U does on purpose: the number stays, the live link goes.
    const state = sheet('100\nline 1 + 5', (line) => (line === 1 ? '100' : null));
    expect(after(state, { changes: { from: 0, to: 4 } })).toBe('100 + 5');
  });

  it('leaves the reference alone when there is no value to freeze', () => {
    // Nothing truthful to put there, and inventing a number would be worse than
    // leaving a reference the sheet will report as broken.
    const state = sheet('not a number\nline 1 + 5');
    expect(after(state, { changes: { from: 0, to: 13 } })).toBe('line 1 + 5');
  });
});

describe('what the renumbering will not touch', () => {
  it('leaves `prev` alone, since it means the line above and still does', () => {
    const state = sheet('100\nprev + 5');
    expect(after(state, { changes: { from: 0, insert: 'x\n' } })).toBe(
      'x\n100\nprev + 5',
    );
  });

  it('leaves a reference inside a comment alone', () => {
    // The engine never resolves one, so rewriting it would be editing a note.
    const state = sheet('100\n// see line 1 for the total');
    expect(after(state, { changes: { from: 0, insert: 'x\n' } })).toBe(
      'x\n100\n// see line 1 for the total',
    );
  });

  it('ignores a reference to a line that does not exist', () => {
    const state = sheet('100\nline 99 + 5');
    expect(after(state, { changes: { from: 0, insert: 'x\n' } })).toBe(
      'x\n100\nline 99 + 5',
    );
  });

  it('sits out a wholesale document swap', () => {
    // Switching sheets: the two documents are unrelated, so mapping line
    // numbers between them would rewrite the arriving sheet.
    const state = sheet('100\nline 1 + 5');
    const swapped = state.update({
      changes: { from: 0, to: state.doc.length, insert: 'a\nb\nline 1 + 2' },
      annotations: replacingDocument.of(true),
    });
    expect(swapped.state.doc.toString()).toBe('a\nb\nline 1 + 2');
  });
});

describe('the correction and its cause', () => {
  it('arrives as one transaction, so a single undo takes back both', () => {
    const state = sheet('100\nline 1 + 5');
    const tr = state.update({ changes: { from: 0, insert: 'x\n' } });

    // One transaction carrying both the insertion and the renumbering is what
    // makes the undo behave. Two dispatches would need two ⌘Z.
    expect(tr.state.doc.toString()).toBe('x\n100\nline 2 + 5');
    expect(tr.startState.doc.toString()).toBe('100\nline 1 + 5');
  });

  it('does not act on its own corrections', () => {
    // The appended changes add no lines, so the filter would gate them out
    // anyway; the annotation makes that independent of the gate.
    const state = sheet('10\n20\nline 1 + line 2');
    const once = state.update({ changes: { from: 0, insert: 'x\n' } }).state;
    expect(once.doc.toString()).toBe('x\n10\n20\nline 2 + line 3');
  });
});
