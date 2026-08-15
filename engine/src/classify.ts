import type { LineKind } from './types.js';

export interface Classified {
  kind: LineKind;
  /** The part of the line to evaluate, with comments and labels stripped. */
  body: string;
  /** Assignment target, for `kind === 'assignment'`. */
  name?: string;
  /** Directive verb, for `kind === 'directive'`. */
  directive?: 'sum' | 'average' | 'count';
  /** Tag a directive is scoped to, e.g. `sum #food`. */
  directiveTag?: string;
  /** Tags found on the line. */
  tags: string[];
  /** Trailing comment text, if any. */
  comment?: string;
}

const DIRECTIVE_RE =
  /^(sum|total|subtotal|average|avg|mean|count)(?:\s+(?:of\s+)?#([\w-]+))?\s*$/i;

/**
 * A variable name: one or more words, optionally spaced, not starting with a
 * digit. Multi-word names are what make `monthly rent = 1500` read naturally.
 */
const ASSIGNMENT_RE = /^([A-Za-z_][\w]*(?:[ \t]+[A-Za-z_][\w]*)*)\s*(?::=|=|:)\s*(.+)$/;

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

export function classify(raw: string): Classified {
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
  body = body.replace(/(^|\s)#([\w-]+)/g, (match, lead: string, tag: string) => {
    // `# Heading` (hash followed by space) is a heading, not a tag; a tag has
    // no space after the hash, which this regex already guarantees.
    tags.push(tag.toLowerCase());
    return lead;
  });

  const trimmed = body.trim();

  if (trimmed === '') {
    return comment !== undefined
      ? { kind: 'comment', body: '', tags, comment }
      : { kind: 'blank', body: '', tags };
  }

  if (/^#{1,6}\s+/.test(trimmed) || /^={3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed)) {
    return { kind: 'heading', body: trimmed, tags, ...(comment !== undefined && { comment }) };
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
      directive: verb === 'count' ? 'count' : verb.startsWith('a') || verb === 'mean' ? 'average' : 'sum',
      ...(scopeTag && { directiveTag: scopeTag }),
      tags,
      ...(comment !== undefined && { comment }),
    };
  }

  const assignment = ASSIGNMENT_RE.exec(trimmed);
  if (assignment) {
    const name = assignment[1]!.trim();
    const value = assignment[2]!.trim();
    const isReserved = name
      .split(/\s+/)
      .some((word) => RESERVED_NAMES.has(word.toLowerCase()));
    // `x == 1` is a comparison, and `a : b` with an empty right side is prose.
    if (!isReserved && value !== '' && !value.startsWith('=')) {
      return {
        kind: 'assignment',
        body: value,
        name,
        tags,
        ...(comment !== undefined && { comment }),
      };
    }
  }

  return { kind: 'expression', body: trimmed, tags, ...(comment !== undefined && { comment }) };
}

/** Index of a `//` comment marker outside any quoted string, or -1. */
function findComment(text: string): number {
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
