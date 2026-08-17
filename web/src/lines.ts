/**
 * What counts as a heading and what counts as a comment.
 *
 * One copy, because two things depend on the answer and must not disagree: the
 * highlighting that greys a line out, and the reference renumbering that leaves
 * greyed-out lines alone. Two sets of rules would eventually diverge, and the
 * divergence would show as the app editing a note it had said it was ignoring.
 *
 * These mirror the engine's own classifier rather than importing it: the engine
 * classifies a line in order to evaluate it, and returns the verdict per line
 * only after evaluation — which is too late for a transaction filter that has
 * to decide before the change is applied.
 */

export function isHeadingLine(text: string): boolean {
  return /^\s*#{1,6}\s/.test(text) || /^\s*[-=]{3,}\s*$/.test(text);
}

export function isCommentLine(text: string): boolean {
  return /^\s*\/\//.test(text);
}
