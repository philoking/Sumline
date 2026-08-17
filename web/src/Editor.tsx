import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, toggleComment } from '@codemirror/commands';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import type { LineResult } from '@webcalc/engine';
import { isCommentLine, isHeadingLine } from './lines';
import { keepReferencesPointing, replacingDocument } from './references';

export interface EditorProps {
  value: string;
  results: LineResult[];
  readOnly: boolean;
  onChange(next: string): void;
}

interface AnswerBox {
  line: number;
  top: number;
  height: number;
}

interface MenuState {
  line: number;
  x: number;
  y: number;
}

/*
 * Soulver sets its sheets in the system sans-serif at a comfortable reading
 * size with a lot of leading, and colours the input text distinctly from the
 * answers. That typography is most of what makes a sheet feel like a document
 * rather than a code editor, so it is matched here rather than approximated
 * with a monospace font.
 */
const editorTheme = EditorView.theme({
  '&': { fontSize: 'var(--sheet-font-size)' },
  '&.cm-editor.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--font-sheet)',
    padding: '0',
    caretColor: 'var(--input-text)',
    color: 'var(--input-text)',
  },
  '.cm-line': {
    padding: '0 12px 0 0',
    lineHeight: 'var(--sheet-line-height)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-cursor': { borderLeftColor: 'var(--input-text)' },
  // Headings and comments are the two things Soulver sets apart from the
  // calculating text, so they are the two things highlighted here.
  '.cm-sheet-heading': { color: 'var(--text)', fontWeight: '600' },
  '.cm-sheet-comment': { color: 'var(--muted)' },
  // The gutter numbers are what make `line 5` references findable, so they
  // are always visible rather than shown on hover.
  '.cm-gutters': {
    background: 'transparent',
    border: 'none',
    color: 'var(--line-number)',
    userSelect: 'none',
  },
  // Scoped under .cm-lineNumbers to outrank CodeMirror's own gutter padding.
  '.cm-lineNumbers .cm-gutterElement': {
    fontFamily: 'var(--font-sheet)',
    fontSize: '12px',
    lineHeight: 'var(--sheet-line-height)',
    padding: '0 20px 0 14px',
    minWidth: '3ch',
    textAlign: 'right',
  },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--muted)' },
  '.cm-selectionBackground, ::selection': { background: 'var(--selection)' },
  '&.cm-focused .cm-selectionBackground': { background: 'var(--selection)' },
  '.cm-placeholder': { color: 'var(--muted)' },
});

/** ⌘\ — cite the nearest line above that produced an answer. */
function insertPreviousReference(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const current = view.state.doc.lineAt(from).number;
  if (current <= 1) return false;
  const before = view.state.sliceDoc(Math.max(0, from - 1), from);
  const text = `${before && !/\s/.test(before) ? ' ' : ''}line ${current - 1}`;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
  return true;
}

/** ⌘T — turn the current line into a subtotal. */
function makeSubtotal(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  if (line.text.trim() !== '') return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: 'sum' },
    selection: { anchor: line.from + 3 },
  });
  return true;
}

/**
 * ⌘⇧U — freeze the references on this line at their current values.
 *
 * Soulver calls this unlinking: the number stays, the live link goes.
 */
function unlinkReferences(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const frozen = line.text.replace(
    /\b(?:line\s*\d+|prev(?:ious)?)\b/gi,
    (token) => resolveReference(view, line.number, token) ?? token,
  );
  if (frozen === line.text) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: frozen } });
  return true;
}

/** The rendered answer of the line a reference points at. */
let answersForUnlink: LineResult[] = [];

/**
 * A line's last answer, as a number a sheet can read back.
 *
 * The separators and currency symbols are stripped because the result is
 * substituted into the text as an operand, not shown as an answer.
 */
function frozenValue(target: number): string | null {
  const output = answersForUnlink[target - 1]?.output;
  return output ? output.replace(/[,$€£¥]/g, '') : null;
}

function resolveReference(
  _view: EditorView,
  currentLine: number,
  token: string,
): string | null {
  const numbered = /line\s*(\d+)/i.exec(token);
  return frozenValue(numbered ? Number(numbered[1]) : currentLine - 1);
}

/** Variable names already declared in the sheet, offered as completions. */
function completeNames(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z][\w ]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const declared = new Set<string>();
  for (const line of context.state.doc.toString().split('\n')) {
    const match = /^([A-Za-z_][\w]*(?:[ \t]+[A-Za-z_][\w]*)*)\s*(?:\+=|-=|=)/.exec(line.trim());
    if (match) declared.add(match[1]!.trim());
  }
  if (declared.size === 0) return null;

  return {
    from: word.from,
    options: [...declared].map((name) => ({ label: name, type: 'variable' })),
  };
}

const HEADING_LINE = Decoration.line({ class: 'cm-sheet-heading' });
const COMMENT_LINE = Decoration.line({ class: 'cm-sheet-comment' });

/** Marks headings and comments so a sheet reads as a document with structure. */
function buildLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (isHeadingLine(line.text)) {
        builder.add(line.from, line.from, HEADING_LINE);
      } else if (isCommentLine(line.text)) {
        builder.add(line.from, line.from, COMMENT_LINE);
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}


const sheetHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildLineDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLineDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function Editor({ value, results, readOnly, onChange }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyCompartment = useRef(new Compartment());
  const [boxes, setBoxes] = useState<AnswerBox[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);

  onChangeRef.current = onChange;

  /**
   * Measures where each visible line sits, so the answer column can be
   * positioned against it. Only the viewport is measured: a long sheet would
   * otherwise cost a full layout pass per keystroke.
   */
  const measure = useRef(() => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (!view || !host) return;

    const hostTop = host.getBoundingClientRect().top;
    const doc = view.state.doc;
    const first = doc.lineAt(view.viewport.from).number;
    const last = doc.lineAt(view.viewport.to).number;

    const next: AnswerBox[] = [];
    for (let number = first; number <= last; number++) {
      const line = doc.line(number);
      const coords = view.coordsAtPos(line.from);
      if (!coords) continue;
      const block = view.lineBlockAt(line.from);
      next.push({ line: number, top: coords.top - hostTop, height: block.height });
    }
    setBoxes(next);
  });

  useLayoutEffect(() => {
    // CodeMirror gets a host element of its own so React never has to
    // reconcile around DOM it did not create.
    const host = editorHostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            // Soulver's own shortcuts, kept familiar.
            { key: 'Mod-\\', run: insertPreviousReference },
            { key: 'Mod-t', run: makeSubtotal },
            { key: 'Mod-/', run: toggleComment },
            { key: 'Mod-Shift-u', run: unlinkReferences },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          autocompletion({ override: [completeNames], icons: false }),
          lineNumbers(),
          keepReferencesPointing(frozenValue),
          sheetHighlighting,
          EditorView.lineWrapping,
          cmPlaceholder('Start typing. Try: 20% of 250'),
          editorTheme,
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.docChanged || update.geometryChanged || update.viewportChanged) {
              requestAnimationFrame(() => measure.current());
            }
          }),
        ],
      }),
    });

    viewRef.current = view;
    requestAnimationFrame(() => measure.current());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; `value` and `readOnly` are synced by the
    // effects below rather than by rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt content that changed outside the editor (switching sheets, or
  // reloading after a conflict) without disturbing an in-progress edit.
  //
  // Annotated so the reference renumbering sits this out: the outgoing and
  // incoming documents are unrelated, and mapping line numbers between them
  // would rewrite the arriving sheet.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
      annotations: replacingDocument.of(true),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
  }, [readOnly]);

  // Answers must follow the text when the window or the surrounding layout
  // changes size, and while the sheet is scrolled.
  useEffect(() => {
    const run = () => measure.current();
    const scroller = hostRef.current?.closest('.sheet-scroll');
    window.addEventListener('resize', run);
    scroller?.addEventListener('scroll', run, { passive: true });
    const observer = new ResizeObserver(run);
    if (hostRef.current) observer.observe(hostRef.current);
    return () => {
      window.removeEventListener('resize', run);
      scroller?.removeEventListener('scroll', run);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => measure.current());
    answersForUnlink = results;
  }, [results]);

  /** Rewrites a line in place, for the answer menu's formatting actions. */
  const amendLine = (lineNumber: number, change: (text: string) => string) => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const line = view.state.doc.line(lineNumber);
    const next = change(line.text);
    if (next === line.text) return;
    view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
    setMenu(null);
    view.focus();
  };

  /*
   * Formatting is applied by editing the line, not by storing hidden state
   * against it. A sheet is plain text; per-line settings kept outside the text
   * would not survive a copy, an export, or the line being moved.
   */
  const setDecimals = (lineNumber: number, places: number) =>
    amendLine(lineNumber, (text) =>
      `${stripFormatting(text)} to ${places} dp`.trim(),
    );

  const writeInFull = (lineNumber: number) =>
    amendLine(lineNumber, (text) => `${stripFormatting(text)} in full`.trim());

  const clearFormatting = (lineNumber: number) =>
    amendLine(lineNumber, (text) => stripFormatting(text).trim());

  /** Turns a blank line into a subtotal, matching the ⌘T shortcut. */
  const subtotalAt = (lineNumber: number) =>
    amendLine(lineNumber, (text) => (text.trim() === '' ? 'sum' : text));

  /** Clicking an answer cites that line, the way Soulver's answer column does. */
  const insertReference = (lineNumber: number) => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const { from, to } = view.state.selection.main;
    const before = view.state.sliceDoc(Math.max(0, from - 1), from);
    const text = `${before && !/\s/.test(before) ? ' ' : ''}line ${lineNumber}`;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  };

  const menuResult = menu ? results[menu.line - 1] : undefined;

  return (
    <div className="sheet-body" ref={hostRef}>
      <div className="editor-host" ref={editorHostRef} />
      <div className="answers">
        {boxes.map((box) => {
          const result = results[box.line - 1];
          if (!result) return null;
          const text = result.output;
          const empty = !text && !result.error;

          // An empty answer slot is still a target: double-clicking one is how
          // Soulver makes a subtotal.
          if (empty) {
            return (
              <button
                key={box.line}
                type="button"
                className="answer answer-empty"
                style={{ top: box.top, height: box.height }}
                title="Double-click to make this a subtotal"
                onDoubleClick={() => subtotalAt(box.line)}
                tabIndex={-1}
              />
            );
          }

          return (
            <button
              key={box.line}
              type="button"
              className={`answer${result.error ? ' answer-error' : ''}`}
              style={{ top: box.top, height: box.height }}
              title={
                result.error
                  ? result.error
                  : `Insert a reference to line ${box.line} — right-click for more`
              }
              draggable={!result.error}
              onDragStart={(event) =>
                event.dataTransfer.setData('text/plain', `line ${box.line}`)
              }
              onClick={() => !result.error && insertReference(box.line)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ line: box.line, x: event.clientX, y: event.clientY });
              }}
              tabIndex={-1}
            >
              {text || '?'}
            </button>
          );
        })}
      </div>

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} />
          <ul className="answer-menu" style={{ left: menu.x, top: menu.y }}>
            <li>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(menuResult?.output ?? '');
                  setMenu(null);
                }}
              >
                Copy answer
              </button>
            </li>
            <li>
              <button type="button" onClick={() => insertReference(menu.line)}>
                Insert reference
              </button>
            </li>
            <li className="menu-separator" />
            {[0, 2, 4].map((places) => (
              <li key={places}>
                <button type="button" onClick={() => setDecimals(menu.line, places)}>
                  {places === 0 ? 'No decimal places' : `${places} decimal places`}
                </button>
              </li>
            ))}
            <li>
              <button type="button" onClick={() => writeInFull(menu.line)}>
                Write number in full
              </button>
            </li>
            <li>
              <button type="button" onClick={() => clearFormatting(menu.line)}>
                Reset formatting
              </button>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

/** Removes any formatting suffix this menu previously added to a line. */
function stripFormatting(text: string): string {
  return text.replace(
    /\s+(?:to\s+\d+\s*(?:dp|decimals?|decimal places?)|in\s+full|as\s+plain)\s*$/i,
    '',
  );
}
