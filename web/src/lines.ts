/**
 * What counts as a comment.
 *
 * This is the reference renumbering's copy, and now the only one: the
 * highlighting used to share it — along with a matching rule for headings —
 * and draws both from the engine's own reading of the line instead, together
 * with everything else it colours.
 *
 * It mirrors the engine's classifier rather than importing it, because the
 * engine classifies a line in order to *evaluate* it: both `evaluate` and
 * `tokenize` want a whole document, and a transaction filter has to decide
 * about one line before the change it is inspecting has been applied.
 */
export function isCommentLine(text: string): boolean {
  return /^\s*\/\//.test(text);
}
