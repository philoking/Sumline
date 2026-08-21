import type { LineKind } from './types.js';

export interface Classified {
  kind: LineKind;
  /** The part of the line to evaluate, with comments and labels stripped. */
  body: string;
  /** Assignment target, for `kind === 'assignment'`. */
  name?: string;
  /** Directive verb, for `kind === 'directive'`. */
  directive?: 'sum' | 'average' | 'count' | 'median';
  /** `+=` and `-=` modify the existing value rather than replacing it. */
  assignOp?: '=' | '+=' | '-=';
  /** Tag a directive is scoped to, e.g. `sum #food`. */
  directiveTag?: string;
  /** Tags found on the line. */
  tags: string[];
  /** Trailing comment text, if any. */
  comment?: string;
}

/** A span of the raw line, as a half-open `[from, to)` pair of offsets. */
export interface Span {
  from: number;
  to: number;
}

const DIRECTIVE_RE =
  /^(sum|total|subtotal|average|avg|mean|median|count)(?:\s+(?:of\s+)?#([\w-]+))?\s*$/i;

/**
 * `#food`, but not `# Heading` — a tag has no space after the hash.
 *
 * Exported because the highlighter marks the same spans this strips, and two
 * ideas of what a tag looks like would show as a `#tag` being coloured on a
 * line the engine never collected it from.
 */
export const TAG_RE = /(^|\s)#([\w-]+)/g;

/**
 * A variable name — one or more words, not starting with a digit — followed by
 * an assignment operator. Multi-word names are what make `monthly rent = 1500`
 * read naturally.
 *
 * A bare colon is deliberately absent: Soulver declares variables with `=` only
 * and reads a trailing colon as a label, so `Cost of iPhone: $999` answers $999
 * without quietly creating a variable.
 */
const ASSIGNMENT_RE =
  /^([A-Za-z_][\w]*(?:[ \t]+[A-Za-z_][\w]*)*)\s*(\+=|-=|:=|=)\s*(.+)$/;

/** Words that must never be treated as a variable name on the left of `=`. */
const RESERVED_NAMES = new Set([
  'sum',
  'total',
  'subtotal',
  'average',
  'avg',
  'mean',
  'count',
  'to',
  'in',
  'as',
  'line',
  'prev',
  'previous',
]);

/**
 * Splits a raw line into what to evaluate and what to ignore.
 *
 * `isKnownWord` reports whether a bare word means something to the engine — a
 * unit, a currency, or a bound variable. Only the parenthesis-comment rule
 * needs it, and it defaults to "nothing is known", which is the safe answer
 * for callers that have no evaluation context: an unrecognised word makes a
 * group look more like prose, never less.
 */
export function classify(
  raw: string,
  isKnownWord: (word: string) => boolean = () => false,
): Classified {
  const tags: string[] = [];

  // Strip a trailing `//` comment, but not one inside a string literal.
  let body = raw;
  let comment: string | undefined;
  const commentAt = findComment(body);
  if (commentAt >= 0) {
    comment = body.slice(commentAt + 2).trim();
    body = body.slice(0, commentAt);
  }

  // Collect and remove tags so they do not reach the expression parser.
  body = body.replace(TAG_RE, (_match, lead: string, tag: string) => {
    tags.push(tag.toLowerCase());
    return lead;
  });

  body = stripQuotedText(body);
  body = stripParentheticalComments(body, isKnownWord);

  const label = extractLabel(body);
  if (label) body = label.rest;

  const trimmed = body.trim();

  if (trimmed === '') {
    return comment !== undefined
      ? { kind: 'comment', body: '', tags, comment }
      : { kind: 'blank', body: '', tags };
  }

  if (/^#{1,6}\s+/.test(trimmed) || /^={3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed)) {
    return {
      kind: 'heading',
      body: trimmed,
      tags,
      ...(comment !== undefined && { comment }),
    };
  }

  const directive = DIRECTIVE_RE.exec(trimmed);
  if (directive) {
    const verb = directive[1]!.toLowerCase();
    // Tags were stripped above, so `sum #food` reaches here as a bare `sum`
    // with the tag already collected; either source is a valid scope.
    const scopeTag = directive[2]?.toLowerCase() ?? tags[0];
    return {
      kind: 'directive',
      body: trimmed,
      directive: directiveFor(verb),
      ...(scopeTag && { directiveTag: scopeTag }),
      tags,
      ...(comment !== undefined && { comment }),
    };
  }

  const assignment = ASSIGNMENT_RE.exec(trimmed);
  if (assignment) {
    const name = assignment[1]!.trim();
    const operator = assignment[2]!;
    const value = assignment[3]!.trim();
    const isReserved = name
      .split(/\s+/)
      .some((word) => RESERVED_NAMES.has(word.toLowerCase()));
    // `x == 1` is a comparison, and `a : b` with an empty right side is prose.
    if (!isReserved && value !== '' && !value.startsWith('=')) {
      return {
        kind: 'assignment',
        body: value,
        name,
        assignOp: operator === '+=' ? '+=' : operator === '-=' ? '-=' : '=',
        tags,
        ...(comment !== undefined && { comment }),
      };
    }
  }

  return {
    kind: 'expression',
    body: trimmed,
    tags,
    ...(comment !== undefined && { comment }),
  };
}

/**
 * `Boeing "747" is $386.8M` — quoted text is commentary, so the number inside
 * it must not reach the parser.
 */
export const QUOTED_RE = /"[^"]*"/g;

function stripQuotedText(text: string): string {
  return text.replace(QUOTED_RE, ' ');
}

/**
 * Words that mark a parenthesised group as arithmetic rather than an aside.
 *
 * Deliberately narrow. `to` and `in` carry conversions and intervals, which is
 * how `(8:30 to 17:15)` is told apart from `(for iPhone 16)`; words like `on`,
 * `of` and `at` appear far too often in real notes to be worth claiming.
 */
const EXPRESSION_KEYWORDS = new Set(['to', 'in', 'per', 'through', 'until', 'mod']);

/**
 * `$999 (for iPhone 16)` — the parenthesised asides in a line, as spans.
 *
 * Testing for letters alone is not enough, because so much of the engine's
 * vocabulary *is* letters: `(8:30 to 17:15)` was being deleted as prose, which
 * left the rest of the line to evaluate without it and answer confidently
 * wrong. A group is only an aside when it cannot be read as arithmetic:
 *
 *  - a group that is the entire line is an expression, never an aside — an
 *    aside is by definition attached to something else;
 *  - an arithmetic operator inside keeps `(3 + 4) * 5` intact, as before;
 *  - a group carrying both digits and engine vocabulary — a unit, a currency,
 *    a bound variable, or a conversion word — is arithmetic.
 *
 * `isKnownWord` is the same predicate the prose-stripper in `evaluate` uses,
 * so the two agree on what counts as engine vocabulary.
 *
 * Spans rather than a rewritten string, because the highlighter has to grey
 * out exactly what this removes and cannot find it again once it is gone.
 */
export function parentheticalAsides(
  text: string,
  isKnownWord: (word: string) => boolean,
): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/(^|[^\w)])\(([^()]*)\)/g)) {
    const [whole, lead = '', inner = ''] = match;
    if (whole.trim() === text.trim()) continue;
    if (!/[A-Za-z]{2}/.test(inner) || /[+\-*/^]/.test(inner)) continue;

    const vocabulary = (inner.match(/[A-Za-z_][\w]*/g) ?? []).some(
      (word) => EXPRESSION_KEYWORDS.has(word.toLowerCase()) || isKnownWord(word),
    );
    if (/\d/.test(inner) && vocabulary) continue;

    const from = (match.index ?? 0) + lead.length;
    spans.push({ from, to: from + whole.length - lead.length });
  }
  return spans;
}

function stripParentheticalComments(
  text: string,
  isKnownWord: (word: string) => boolean,
): string {
  const spans = parentheticalAsides(text, isKnownWord);
  if (spans.length === 0) return text;

  let out = '';
  let at = 0;
  for (const { from, to } of spans) {
    out += text.slice(at, from);
    at = to;
  }
  return out + text.slice(at);
}

/**
 * `Cost of 128 GB iPhone 16: $999` — the label, colon and all, as a span.
 *
 * Requires whitespace after the colon, which is how Soulver keeps a label
 * distinct from a clock time like `14:45`.
 *
 * A span for the same reason the asides above are: the highlighter must leave
 * the label alone, and `128 GB` inside one would otherwise be coloured as a
 * quantity the engine never reads.
 */
export function labelSpan(text: string): Span | null {
  const lead = text.length - text.trimStart().length;
  const m = /^([^:]*[A-Za-z][^:]*):(\s+)\S.*$/.exec(text.trim());
  if (!m) return null;
  // A label is prose, not an expression: reject anything operator-shaped so
  // `a + b: 3` is not silently swallowed.
  if (/[+\-*/^=<>]/.test(m[1]!)) return null;
  return { from: lead, to: lead + m[1]!.length + 1 + m[2]!.length };
}

function extractLabel(text: string): { rest: string } | null {
  const span = labelSpan(text);
  return span ? { rest: text.slice(span.to) } : null;
}

function directiveFor(verb: string): 'sum' | 'average' | 'count' | 'median' {
  if (verb === 'count') return 'count';
  if (verb === 'median') return 'median';
  return verb === 'mean' || verb.startsWith('a') ? 'average' : 'sum';
}

/** Index of a `//` comment marker outside any quoted string, or -1. */
export function findComment(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      return i;
    }
  }
  return -1;
}
