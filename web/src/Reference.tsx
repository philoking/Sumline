import { useMemo, useState } from 'react';
import { EXAMPLE_GROUPS, type ExampleGroup } from '@webcalc/engine';

export interface ReferenceProps {
  open: boolean;
  currencies: string[];
  rateDate: string | null;
  holidayCount: number;
  onClose(): void;
  /** Puts an example into the sheet, which is what makes this explorable. */
  onInsert(line: string): void;
}

const SHORTCUTS: Array<[string, string]> = [
  ['Mod + \\', 'Reference the line above'],
  ['Mod + T', 'Make the blank line a subtotal'],
  ['Mod + /', 'Comment the line out'],
  ['Mod + Shift + U', 'Freeze this line’s references'],
  ['Mod + Shift + N', 'New sheet'],
  ['Mod + F', 'Search sheets'],
  ['?', 'Open and close this reference'],
];

export function Reference({
  open,
  currencies,
  rateDate,
  holidayCount,
  onClose,
  onInsert,
}: ReferenceProps) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => filterGroups(EXAMPLE_GROUPS, query), [query]);
  const total = useMemo(
    () => EXAMPLE_GROUPS.reduce((count, group) => count + group.examples.length, 0),
    [],
  );

  if (!open) return null;

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <aside className="reference" aria-label="Syntax reference">
        <header className="reference-head">
          <strong>Reference</strong>
          <input
            type="search"
            value={query}
            placeholder={`Search ${total} examples`}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search the reference"
            autoFocus
          />
          <button type="button" className="ghost" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="reference-body">
          {query === '' && (
            <>
              <section className="reference-group">
                <h3>How a sheet works</h3>
                <p className="reference-blurb">
                  Type on the left; answers appear on the right as you go. Anything
                  the engine doesn’t recognise is left alone, so notes and sums can
                  share a sheet. Start a line with <code>#</code> for a heading or{' '}
                  <code>//</code> for a comment. Click an answer to cite it, or
                  right-click one to change how it’s shown.
                </p>
                <p className="reference-blurb">
                  Every example below is checked by the test suite on each deploy,
                  so nothing here can claim something the calculator doesn’t do.
                  Click one to try it in your sheet.
                </p>
              </section>

              <section className="reference-group">
                <h3>Keyboard</h3>
                <dl className="shortcut-list">
                  {SHORTCUTS.map(([keys, action]) => (
                    <div key={keys}>
                      <dt>{keys}</dt>
                      <dd>{action}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </>
          )}

          {groups.map((group) => (
            <section className="reference-group" key={group.id}>
              <h3>{group.title}</h3>
              <p className="reference-blurb">{group.blurb}</p>
              {group.note && <p className="reference-note">{group.note}</p>}
              <ul className="example-list">
                {group.examples.map((example) => (
                  <li key={example.input}>
                    <button
                      type="button"
                      onClick={() => onInsert(example.input)}
                      title="Insert into the sheet"
                    >
                      <span className="example-input">{example.input}</span>
                      <span className="example-answer">{example.expected}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {groups.length === 0 && (
            <p className="reference-blurb">Nothing matches “{query}”.</p>
          )}

          {query === '' && (
            <section className="reference-group">
              <h3>This instance</h3>
              <p className="reference-blurb">
                {currencies.length} currencies loaded
                {rateDate ? `, rates from ${rateDate}` : ', no rates available'}.{' '}
                {holidayCount > 0
                  ? `${holidayCount} public holidays known, used for workday maths.`
                  : 'No public holidays loaded, so workdays count weekends only.'}
              </p>
              <h3>Not supported</h3>
              <p className="reference-blurb">
                Sales tax, compound interest, loan repayments and inflation;
                conditionals, number bases and bitwise operators; live stock,
                weather and knowledge lookups; and trip planning. Each was
                deliberately left out rather than missed — see the closed
                milestones in the repository for why.
              </p>
              <h3>Credits</h3>
              <p className="reference-blurb">
                The notepad calculator is{' '}
                <a href="https://soulver.app/" target="_blank" rel="noreferrer noopener">
                  Soulver
                </a>
                ’s idea. Soulver worked out how a sheet like this should behave, and
                its documentation was the specification this was built against.
                WebCalc is an independent implementation, unaffiliated with
                Soulver’s makers — if you want the polished native original, buy it.
              </p>
              <p className="reference-blurb">
                Exchange rates from{' '}
                <a href="https://frankfurter.dev/" target="_blank" rel="noreferrer noopener">
                  Frankfurter
                </a>{' '}
                (European Central Bank data); public holidays from{' '}
                <a href="https://date.nager.at/" target="_blank" rel="noreferrer noopener">
                  Nager.Date
                </a>
                .
              </p>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

/** Matches a group's title, its blurb, or any of its examples. */
function filterGroups(groups: ExampleGroup[], query: string): ExampleGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  return groups
    .map((group) => {
      if (group.title.toLowerCase().includes(needle)) return group;
      const examples = group.examples.filter(
        (example) =>
          example.input.toLowerCase().includes(needle) ||
          example.expected.toLowerCase().includes(needle),
      );
      return examples.length > 0 ? { ...group, examples } : null;
    })
    .filter((group): group is ExampleGroup => group !== null);
}
