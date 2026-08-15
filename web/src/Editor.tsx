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
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { LineResult } from '@webcalc/engine';

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

const HEADING_LINE = Decoration.line({ class: 'cm-sheet-heading' });
const COMMENT_LINE = Decoration.line({ class: 'cm-sheet-comment' });

/** Marks headings and comments so a sheet reads as a document with structure. */
function buildLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (/^\s*#{1,6}\s/.test(line.text) || /^\s*[-=]{3,}\s*$/.test(line.text)) {
        builder.add(line.from, line.from, HEADING_LINE);
      } else if (/^\s*\/\//.test(line.text)) {
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
          keymap.of([...defaultKeymap, ...historyKeymap]),
          lineNumbers(),
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
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
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
  }, [results]);

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

  return (
    <div className="sheet-body" ref={hostRef}>
      <div className="editor-host" ref={editorHostRef} />
      <div className="answers">
        {boxes.map((box) => {
          const result = results[box.line - 1];
          if (!result) return null;
          const text = result.output;
          if (!text && !result.error) return null;
          return (
            <button
              key={box.line}
              type="button"
              className={`answer${result.error ? ' answer-error' : ''}`}
              style={{ top: box.top, height: box.height }}
              title={
                result.error
                  ? result.error
                  : `Insert a reference to line ${box.line}`
              }
              onClick={() => !result.error && insertReference(box.line)}
              tabIndex={-1}
            >
              {text || '?'}
            </button>
          );
        })}
      </div>
    </div>
  );
}
