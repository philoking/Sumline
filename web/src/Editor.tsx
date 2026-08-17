import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { Compartment, EditorState, Facet, RangeSetBuilder } from '@codemirror/state';
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
import {
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from '@codemirror/search';
import type { LineResult, Token, TokenKind } from '@webcalc/engine';
import { keepReferencesPointing, replacingDocument } from './references';

/** How a sheet's text is read — `engine.tokenize`, handed in by the app. */
export type Tokenize = (source: string) => Token[][];

/** What the app can ask of the sheet from outside it. */
export interface EditorHandle {
  /** Opens the find and replace panel, as ⌘F does from inside the sheet. */
  openSearch(): void;
}

export interface EditorProps {
  value: string;
  results: LineResult[];
  readOnly: boolean;
  onChange(next: string): void;
  /**
   * A line to select and scroll to — how a cross-sheet text result is landed
   * on. Null except in the render that answers one.
   */
  reveal: number | null;
  /** Called once `reveal` has been acted on, so the app can clear it. */
  onRevealed(): void;
  /**
   * The figure for a run of lines, asked for when a selection covers more than
   * one. Returns null when those lines add up to nothing worth showing.
   *
   * A callback rather than the engine itself, because which statistic is being
   * shown and whether variable lines count towards it are the app's business —
   * and the selection figure has to answer the same question the corner does or
   * the two would disagree about what "the figure" means.
   */
  summarise(from: number, to: number): { label: string; value: string } | null;
  /** Whether the gutter is drawn. Off is View → Line numbers, unticked. */
  showLineNumbers: boolean;
  /**
   * How the sheet is coloured — the engine's own reading of the text.
   *
   * A callback rather than a set of rules here, for the reason `summarise` is
   * one: a second idea of what a token is would drift from the engine's, and
   * the drift would show as a sheet coloured as though it meant something it
   * does not. See `tokenize` on the engine.
   */
  tokenize: Tokenize;
  ref?: Ref<EditorHandle>;
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

/** Where a popover was asked for, so it can be placed against its answer. */
interface PopoverAt {
  line: number;
  x: number;
  y: number;
}

/** The run of lines a selection covers. */
interface Span {
  from: number;
  to: number;
}

/**
 * The lines a selection covers, or null when there is no useful question.
 *
 * A selection inside one line is not worth answering — the answer to that line
 * is already sitting beside it — so this reports only runs of two or more.
 *
 * Dragging to the start of the next line is the ordinary way to select whole
 * lines, and it leaves the selection technically touching a line none of whose
 * text is in it. That line is dropped, or selecting three lines by dragging
 * through them would report four.
 */
function selectionSpan(view: EditorView): Span | null {
  const { from, to, empty } = view.state.selection.main;
  if (empty) return null;

  const first = view.state.doc.lineAt(from).number;
  const lastLine = view.state.doc.lineAt(to);
  const last = to === lastLine.from && lastLine.number > first
    ? lastLine.number - 1
    : lastLine.number;

  return last > first ? { from: first, to: last } : null;
}

function sameSpan(a: Span | null, b: Span | null): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

/**
 * Where to put a popover raised from an answer.
 *
 * `x` is the edge it is anchored *to the right of* — see `placePopover`.
 *
 * `Shift+F10` and the Menu key raise a `contextmenu` event like a right-click
 * does, but with no pointer behind it: the coordinates are 0,0, which would pin
 * the menu to the corner of the window. Falling back to the button's own box
 * puts it where a right-click on that answer would have.
 */
function popoverFrom(event: {
  clientX: number;
  clientY: number;
  currentTarget: HTMLElement;
}): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.right, y: rect.bottom };
}

/** Roughly how tall the answer menu is, for deciding which way it opens. */
const MENU_HEIGHT = 230;
/** The error note is one short paragraph, so it needs far less room. */
const NOTE_HEIGHT = 90;

/**
 * Places a popover against the answer that raised it.
 *
 * Anchored by its *right* edge rather than its left, because the answer column
 * sits at the right of the window: a menu growing rightwards from an answer
 * runs straight off the screen, which is what both of these did. Growing
 * leftwards puts them over the sheet, which is the roomy direction.
 *
 * Flipped upwards when there is no space below, for the same reason and by the
 * same reckoning as the sidebar's flyout — guessing the height high only opens
 * a popover upwards a little sooner than it had to, while guessing low leaves
 * one clipped at the bottom of the window.
 */
function placePopover(at: PopoverAt, height: number): CSSProperties {
  return {
    right: Math.max(8, window.innerWidth - at.x),
    ...(at.y + height > window.innerHeight
      ? { bottom: Math.max(8, window.innerHeight - at.y) }
      : { top: at.y }),
  };
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
    // The colour of everything the engine does *not* read: labels, notes, the
    // words around a sum. It is the quietest thing in the sheet because it is
    // the part that does not calculate — see the palette below.
    color: 'var(--sheet-prose)',
  },
  '.cm-line': {
    padding: '0 12px 0 0',
    lineHeight: 'var(--sheet-line-height)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-cursor': { borderLeftColor: 'var(--input-text)' },

  /*
   * The sheet's colouring, one class per kind the engine reports.
   *
   * Five colours and two weights, which is fewer than the eleven kinds — the
   * engine says precisely what it read, and the palette groups what a reader
   * has no reason to tell apart. A currency is the dimension of a number in
   * the same way a unit is; `line 5` is a variable that happens to be
   * numbered; a directive is a keyword said in the imperative, so it takes the
   * keyword's colour and the heading's weight.
   *
   * The set is deliberately close-toned. A notepad calculator is a document
   * you read, not a program you debug, and a sheet lit up like a terminal is
   * harder to read down than a plain one. Numbers keep the blue the sheet has
   * always used for what you type, which leaves it the brightest thing on the
   * line — the answer column is on the right, but the figures are here.
   */
  '.cm-sheet-heading': { color: 'var(--text)', fontWeight: '600' },
  '.cm-sheet-comment': { color: 'var(--muted)' },
  '.cm-sheet-number': { color: 'var(--input-text)' },
  '.cm-sheet-unit, .cm-sheet-currency': { color: 'var(--sheet-unit)' },
  '.cm-sheet-name, .cm-sheet-reference': { color: 'var(--sheet-name)' },
  '.cm-sheet-operator, .cm-sheet-keyword': { color: 'var(--sheet-keyword)' },
  '.cm-sheet-directive': { color: 'var(--sheet-keyword)', fontWeight: '600' },
  '.cm-sheet-tag': { color: 'var(--sheet-tag)' },
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

  /*
   * The find and replace panel.
   *
   * CodeMirror ships it with browser-default form controls, which in a sheet
   * this quiet read as a piece of another application. It is restyled here
   * rather than in styles.css because it lives inside the editor's own DOM,
   * next to the rules that already dress that DOM — and unlike the rest of the
   * app it is set in the interface font, since it is a control panel and not
   * part of the document.
   */
  '.cm-panels': {
    background: 'var(--panel)',
    color: 'var(--text)',
    border: 'none',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 30px 8px 10px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    font: 'inherit',
    fontSize: '12.5px',
    margin: '0',
  },
  // Selected by what they are not, because CodeMirror builds the two text
  // fields with no `type` attribute at all — `input[type=text]` matches the
  // default property but not the missing attribute, and so styles neither.
  '.cm-panel.cm-search input:not([type=checkbox])': {
    minWidth: '150px',
    padding: '4px 8px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '7px',
    color: 'var(--text)',
  },
  '.cm-panel.cm-search input:not([type=checkbox]):focus': {
    outline: 'none',
    borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search button:not([name=close])': {
    padding: '4px 9px',
    background: 'var(--hover)',
    backgroundImage: 'none',
    border: '1px solid var(--border)',
    borderRadius: '7px',
    color: 'var(--text)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button:not([name=close]):hover': { background: 'var(--active)' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: 'var(--muted)',
  },
  '.cm-panel.cm-search [name=close]': {
    top: '6px',
    right: '8px',
    padding: '0 4px',
    background: 'none',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    fontSize: '16px',
  },
  // The same pair of blues the sheet already uses for a selection, so a run of
  // matches and the one you are standing on are told apart the same way.
  '.cm-searchMatch': { background: 'var(--selection)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    background: 'var(--accent)',
    color: 'var(--bg)',
  },
});

/**
 * Selects a line and brings it into view.
 *
 * How a result from the cross-sheet search is landed on: the sheet opens, and
 * then the line that matched is put in the middle of the screen with the caret
 * on it, so the next keystroke edits what was searched for.
 */
function showLine(view: EditorView, line: number): void {
  if (line < 1 || line > view.state.doc.lines) return;
  const target = view.state.doc.line(line);
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  });
  view.focus();
}

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

/**
 * The engine that reads this sheet.
 *
 * A facet rather than a closed-over variable, so the plugin below sees a new
 * one arriving — rates landing adds every currency at once, and until they do
 * `€` is a symbol the engine does not know.
 */
const sheetTokens = Facet.define<Tokenize, Tokenize>({
  combine: (values) => values[0] ?? (() => []),
});

const marks = new Map<TokenKind, Decoration>();

function markFor(kind: TokenKind): Decoration {
  const existing = marks.get(kind);
  if (existing) return existing;
  const mark = Decoration.mark({ class: `cm-sheet-${kind}` });
  marks.set(kind, mark);
  return mark;
}

/**
 * Turns the engine's reading of the sheet into decorations for what is on
 * screen.
 *
 * Only the visible lines are decorated, for the same reason only the visible
 * lines are measured for the answer column: a long sheet would otherwise cost
 * a decoration per line per keystroke.
 */
function buildDecorations(view: EditorView, tokens: Token[][]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      // A range can begin part-way through a line the previous one already
      // covered, and the builder requires each range added exactly once.
      if (line.number <= last) continue;
      last = line.number;

      for (const token of tokens[line.number - 1] ?? []) {
        const start = line.from + Math.min(token.from, line.length);
        const end = line.from + Math.min(token.to, line.length);
        if (end > start) builder.add(start, end, markFor(token.kind));
      }
    }
  }
  return builder.finish();
}

/**
 * Colours the sheet from the engine's own reading of it.
 *
 * The whole document is tokenized rather than the visible part, because a
 * variable is only a variable from its declaration downwards: a viewport
 * starting at line 40 cannot tell what line 12 named. It costs a pass over the
 * text, which is a fraction of the evaluation the sheet is already doing on
 * every keystroke, and the result is cached until the text changes so
 * scrolling redraws without re-reading.
 */
const sheetHighlighting = ViewPlugin.fromClass(
  class {
    tokens: Token[][];
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.tokens = view.state.facet(sheetTokens)(view.state.doc.toString());
      this.decorations = buildDecorations(view, this.tokens);
    }

    update(update: ViewUpdate) {
      const reread =
        update.docChanged ||
        update.startState.facet(sheetTokens) !== update.state.facet(sheetTokens);
      if (reread) {
        this.tokens = update.state.facet(sheetTokens)(update.state.doc.toString());
      }
      if (reread || update.viewportChanged) {
        this.decorations = buildDecorations(update.view, this.tokens);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function Editor({
  value,
  results,
  readOnly,
  onChange,
  reveal,
  onRevealed,
  summarise,
  showLineNumbers,
  tokenize,
  ref,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRevealedRef = useRef(onRevealed);
  const readOnlyCompartment = useRef(new Compartment());
  const gutterCompartment = useRef(new Compartment());
  const tokenizeCompartment = useRef(new Compartment());
  const answersRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const [boxes, setBoxes] = useState<AnswerBox[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** The failed line whose message is being shown, and where to show it. */
  const [errorAt, setErrorAt] = useState<PopoverAt | null>(null);
  /**
   * The line the caret is on, which is the one answer the column offers to the
   * Tab key — see `tabStop`.
   */
  const [activeLine, setActiveLine] = useState(1);
  /**
   * The selected run of lines, and where to float its figure.
   *
   * Two pieces rather than one so that scrolling, which moves the figure,
   * does not also look like the selection changing and send the sheet's
   * statistic through the engine again on every frame.
   */
  const [span, setSpan] = useState<Span | null>(null);
  const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);

  onChangeRef.current = onChange;
  onRevealedRef.current = onRevealed;

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

    // The floating figure is placed in the same pass as the answers, so it
    // follows the sheet when it scrolls or the layout reflows rather than
    // hanging where the selection used to be on screen.
    const selected = selectionSpan(view);
    setSpan((previous) => (sameSpan(previous, selected) ? previous : selected));
    if (!selected) {
      setSpot(null);
      return;
    }

    const caret = view.coordsAtPos(view.state.selection.main.head);
    if (!caret) {
      setSpot(null);
      return;
    }
    /*
     * Beside the end of the selection rather than below it.
     *
     * Below looks tidier until you try it: the line under a selection is the
     * one you are about to extend onto, and covering it is the one thing this
     * must not do. Sheets leave the right of the text column empty, so sitting
     * on the same line as the selection's end usually covers nothing at all.
     */
    const textWidth =
      editorHostRef.current?.getBoundingClientRect().width ?? host.clientWidth;
    const hostLeft = host.getBoundingClientRect().left;
    const top = Math.round(caret.top - hostTop + 4);
    const left = Math.round(
      Math.max(0, Math.min(caret.left - hostLeft + 14, textWidth - 150)),
    );
    setSpot((previous) =>
      previous && previous.top === top && previous.left === left
        ? previous
        : { top, left },
    );
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
            // Ahead of the default keymap, which claims Mod-d for its own use.
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          autocompletion({ override: [completeNames], icons: false }),
          // At the top, where a browser's own find bar sits, rather than at the
          // bottom over the total.
          search({ top: true }),
          gutterCompartment.current.of(showLineNumbers ? lineNumbers() : []),
          keepReferencesPointing(frozenValue),
          tokenizeCompartment.current.of(sheetTokens.of(tokenize)),
          sheetHighlighting,
          EditorView.lineWrapping,
          cmPlaceholder('Start typing. Try: 20% of 250'),
          editorTheme,
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              // React drops the update when the number has not changed, so
              // this costs a render per line moved between, not per keystroke.
              const { head } = update.state.selection.main;
              setActiveLine(update.state.doc.lineAt(head).number);
              // Selecting changes neither the document nor the geometry, so
              // nothing else here would notice a selection being dragged.
              requestAnimationFrame(() => measure.current());
            }
            // The find panel opening or closing takes a strip of height off
            // the top of the sheet, which moves every line down the screen
            // without changing the document, the viewport or the editor's own
            // geometry — so none of the three flags above notice it, and the
            // answer column would go on sitting where the lines used to be.
            const panelMoved =
              searchPanelOpen(update.startState) !== searchPanelOpen(update.state);
            if (
              update.docChanged ||
              update.geometryChanged ||
              update.viewportChanged ||
              panelMoved
            ) {
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

  useImperativeHandle(
    ref,
    () => ({
      openSearch() {
        const view = viewRef.current;
        if (!view) return;
        // The answer column is put right by the update listener, which sees
        // this panel open however it was asked for — from here or from the
        // editor's own ⌘F.
        openSearchPanel(view);
      },
    }),
    [],
  );

  // Adopt content that changed outside the editor (switching sheets, or
  // reloading after a conflict) without disturbing an in-progress edit.
  //
  // Annotated so the reference renumbering sits this out: the outgoing and
  // incoming documents are unrelated, and mapping line numbers between them
  // would rewrite the arriving sheet.
  //
  // A line asked for by a search result is shown from here rather than from an
  // effect of its own, because the two arrive together: opening a text result
  // changes the sheet, and this is the first moment the sheet it belongs to is
  // actually in the editor. An effect watching `reveal` alone would scroll the
  // outgoing document to a line number that means nothing in it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
        annotations: replacingDocument.of(true),
      });
    }
    if (reveal === null) return;
    showLine(view, reveal);
    onRevealedRef.current();
  }, [value, reveal]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
  }, [readOnly]);

  // A new engine reads the sheet differently — currencies arrive with the
  // rates, and the number format follows the space's region — so the colouring
  // is rebuilt when one does rather than waiting for the next keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: tokenizeCompartment.current.reconfigure(sheetTokens.of(tokenize)),
    });
  }, [tokenize]);

  // Dropping the gutter moves every line left, so the answers have to be
  // placed again — the same reason the find panel needs a measure.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: gutterCompartment.current.reconfigure(
        showLineNumbers ? lineNumbers() : [],
      ),
    });
    requestAnimationFrame(() => measure.current());
  }, [showLineNumbers]);

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

  // Recomputed when the selection moves or the answers change, not when the
  // sheet is merely scrolled — see the two pieces of state above.
  const figure = useMemo(
    () => (span ? summarise(span.from, span.to) : null),
    [span, summarise],
  );

  /*
   * One tab stop for the whole column, on the line the caret is sitting on.
   *
   * The alternative — every answer in the tab order — would put seventy stops
   * between the sheet and the total on a sheet of any length. This way Tab out
   * of the text lands on the answer beside where you were already working, and
   * the arrow keys walk the column from there. If that line has no box yet the
   * first one takes the stop, so the column is never unreachable.
   */
  const tabStop = boxes.some((box) => box.line === activeLine)
    ? activeLine
    : (boxes[0]?.line ?? 0);

  const focusAnswer = (line: number) => {
    answersRef.current
      ?.querySelector<HTMLButtonElement>(`[data-line="${line}"]`)
      ?.focus();
  };

  /** Arrow keys walk the column; Escape hands the keyboard back to the sheet. */
  const onAnswerKey = (event: ReactKeyboardEvent<HTMLButtonElement>, line: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = boxes.findIndex((box) => box.line === line);
      const next = boxes[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) focusAnswer(next.line);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      viewRef.current?.focus();
    }
  };

  /*
   * Both popovers hand focus back to the answer that raised them.
   *
   * The answer stays mounted while its menu is open, so it is still there to
   * receive focus — and landing back on it is what makes a menu opened with
   * Shift+F10 escapable without reaching for the mouse.
   */
  const closeMenu = () => {
    const line = menu?.line;
    setMenu(null);
    if (line !== undefined) focusAnswer(line);
  };

  const closeError = () => {
    const line = errorAt?.line;
    setErrorAt(null);
    if (line !== undefined) focusAnswer(line);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  // A menu is no use to the keyboard that raised it if focus stays behind.
  useEffect(() => {
    if (menu) menuRef.current?.querySelector('button')?.focus();
  }, [menu]);

  useEffect(() => {
    if (errorAt) errorRef.current?.focus();
  }, [errorAt]);

  return (
    <div className="sheet-body" ref={hostRef}>
      <div
        className={`editor-host${showLineNumbers ? '' : ' no-gutter'}`}
        ref={editorHostRef}
      />
      <div
        className="answers"
        ref={answersRef}
        role="group"
        aria-label="Answers"
      >
        {boxes.map((box) => {
          const result = results[box.line - 1];
          if (!result) return null;
          const text = result.output;
          const empty = !text && !result.error;

          // An empty answer slot is still a target: double-clicking one is how
          // Soulver makes a subtotal. Enter does it from the keyboard, since a
          // single click here has never meant anything and making it mean this
          // would turn a stray click into an edit.
          if (empty) {
            return (
              <button
                key={box.line}
                type="button"
                className="answer answer-empty"
                style={{ top: box.top, height: box.height }}
                title="Double-click to make this a subtotal"
                aria-label={`Line ${box.line}, no answer. Make it a subtotal.`}
                data-line={box.line}
                onDoubleClick={() => subtotalAt(box.line)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    subtotalAt(box.line);
                    return;
                  }
                  onAnswerKey(event, box.line);
                }}
                tabIndex={box.line === tabStop ? 0 : -1}
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
              // The `?` is the whole accessible name otherwise, and the message
              // lives in `title`, which a touch device never shows and a screen
              // reader is not obliged to read.
              aria-label={
                result.error
                  ? `Line ${box.line} could not be worked out: ${result.error}`
                  : `Line ${box.line}: ${text}`
              }
              data-line={box.line}
              draggable={!result.error}
              onDragStart={(event) =>
                event.dataTransfer.setData('text/plain', `line ${box.line}`)
              }
              onClick={(event) => {
                // A failed line has no reference worth citing, so the click is
                // free to do the thing there was previously no way to do on a
                // phone: say what went wrong.
                if (result.error) {
                  setErrorAt({ line: box.line, ...popoverFrom(event) });
                  return;
                }
                insertReference(box.line);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ line: box.line, ...popoverFrom(event) });
              }}
              onKeyDown={(event) => onAnswerKey(event, box.line)}
              tabIndex={box.line === tabStop ? 0 : -1}
            >
              {text || '?'}
            </button>
          );
        })}
      </div>

      {/* The same figure the corner shows, asked of part of the sheet. It never
          takes the pointer: it floats over the text you are selecting, and
          swallowing a click there would be worse than not being there. */}
      {span && spot && figure && (
        <div className="selection-figure" style={{ top: spot.top, left: spot.left }}>
          <span className="selection-figure-label">{figure.label}</span>
          <span className="selection-figure-value">{figure.value}</span>
          <span className="selection-figure-lines">{span.to - span.from + 1} lines</span>
        </div>
      )}

      {errorAt && (
        <>
          <div className="menu-backdrop" onClick={() => setErrorAt(null)} />
          <div
            className="answer-menu error-note"
            role="dialog"
            aria-label={`Why line ${errorAt.line} has no answer`}
            style={placePopover(errorAt, NOTE_HEIGHT)}
            ref={errorRef}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeError();
            }}
          >
            <p>{results[errorAt.line - 1]?.error}</p>
          </div>
        </>
      )}

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => closeMenu()} />
          <ul
            className="answer-menu"
            role="menu"
            aria-label={`Line ${menu.line}`}
            style={placePopover(menu, MENU_HEIGHT)}
            ref={menuRef}
            onKeyDown={onMenuKey}
          >
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(menuResult?.output ?? '');
                  closeMenu();
                }}
              >
                Copy answer
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Closed here rather than in `insertReference`, which the
                  // answer column also calls with no menu open.
                  setMenu(null);
                  insertReference(menu.line);
                }}
              >
                Insert reference
              </button>
            </li>
            <li className="menu-separator" />
            {[0, 2, 4].map((places) => (
              <li key={places}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setDecimals(menu.line, places)}
                >
                  {places === 0 ? 'No decimal places' : `${places} decimal places`}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => writeInFull(menu.line)}
              >
                Write number in full
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => clearFormatting(menu.line)}
              >
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
