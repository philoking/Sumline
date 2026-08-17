import type { SheetMatch } from './api';

/**
 * The matching line of a search result, with the search term marked.
 *
 * The offsets come from the server, which found the match — recomputing them
 * here against the query would be a second implementation of the same search,
 * and the two would disagree on the first line that contains the term twice.
 *
 * Shared by the sidebar and the palette rather than written twice: both are
 * quoting the same `SheetMatch`, and a highlight that looked different in the
 * two places would suggest they had found different things.
 */
export function Snippet({ match }: { match: SheetMatch }) {
  const before = match.text.slice(0, match.at);
  const hit = match.text.slice(match.at, match.at + match.length);
  const after = match.text.slice(match.at + match.length);
  return (
    <span className="sheet-match">
      {match.truncated && '…'}
      {before}
      <mark>{hit}</mark>
      {after}
      {match.truncated && '…'}
    </span>
  );
}
