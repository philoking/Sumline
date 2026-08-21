import { useEffect, useRef, useState } from 'react';

/**
 * Editing a set of named variables.
 *
 * Shared by the space panel and the global one, so a variable is edited the same
 * way wherever it lives. The only difference between the two is which set is
 * being written, and what a name in it displaces.
 */

export interface Row {
  name: string;
  value: string;
}

export function toRows(globals: Record<string, string>): Row[] {
  return Object.entries(globals).map(([name, value]) => ({ name, value }));
}

export function named(rows: Row[]): Row[] {
  return rows.filter((row) => row.name.trim() !== '');
}

function hasDuplicate(rows: Row[]): boolean {
  const keys = named(rows).map((row) => row.name.trim());
  return keys.some((key, index) => keys.indexOf(key) !== index);
}

function toRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.name.trim();
    if (key !== '') out[key] = row.value.trim();
  }
  return out;
}

/** Whether the rows still say what the stored set says. */
function changed(rows: Row[], stored: Record<string, string>): boolean {
  return JSON.stringify(toRecord(rows)) !== JSON.stringify(toRecord(toRows(stored)));
}

interface EditorProps {
  rows: Row[];
  setRows(next: (current: Row[]) => Row[]): void;
  stored: Record<string, string>;
  preview(expression: string): string;
  onSave(globals: Record<string, string>): void;
  /** Names defined here that displace a value from the tier above. */
  shadowing?: Record<string, string>;
}

export function GlobalsEditor({
  rows,
  setRows,
  stored,
  preview,
  onSave,
  shadowing = {},
}: EditorProps) {
  const duplicate = hasDuplicate(rows);
  const dirty = changed(rows, stored);

  return (
    <>
      <div className="globals-editor">
        {rows.map((row, index) => {
          const answer = row.value.trim() === '' ? '' : preview(row.value);
          const displaced = shadowing[row.name.trim()];
          return (
            <div className="global-row-group" key={index}>
              <div className="global-row">
                <input
                  value={row.name}
                  placeholder="day rate"
                  aria-label={`Variable ${index + 1} name`}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <input
                  value={row.value}
                  placeholder="$550"
                  aria-label={`Variable ${index + 1} value`}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    )
                  }
                />
                {/* What it actually works out to, so a typo shows here rather
                    than as a sheet that quietly answers nothing. */}
                <span
                  className={`global-answer${answer === '' ? ' global-answer-none' : ''}`}
                  title={answer || 'This does not evaluate to anything'}
                >
                  {answer || '—'}
                </span>
                <button
                  type="button"
                  className="ghost"
                  title="Remove this variable"
                  aria-label={`Remove variable ${index + 1}`}
                  onClick={() =>
                    setRows((current) => current.filter((_, i) => i !== index))
                  }
                >
                  ×
                </button>
              </div>
              {/* Says what this row displaced. Without it, the same name
                  meaning different things in different spaces is invisible. */}
              {displaced !== undefined && (
                <p className="global-shadow-note">
                  Overrides <code>{displaced}</code> from Everywhere
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="globals-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => setRows((current) => [...current, { name: '', value: '' }])}
        >
          + Add variable
        </button>
        <button
          type="button"
          className="primary"
          disabled={!dirty || duplicate}
          onClick={() => {
            if (!duplicate) onSave(toRecord(rows));
          }}
        >
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>

      {duplicate && (
        <p className="reference-note global-warning">
          Two variables share a name. Only one could ever win, so nothing is saved
          until that is settled.
        </p>
      )}
    </>
  );
}

/**
 * Everything about one space in one place, plus the tier above it.
 *
 * Only the space currently in use can be edited, because the settings API is
 * scoped by the same cookie that decides which sheets you see. Editing another
 * space means switching to it first — said out loud in the panel rather than
 * left for the reader to infer.
 *
 * Inherited values are shown rather than hidden. Two silent tiers of globals
 * would be exactly the invisible state this project avoids elsewhere: a figure
 * right in one space and wrong in another, with nothing on screen saying why.
 */
/**
 * Keeps a set of rows in step with the stored set whenever a panel opens.
 *
 * On opening, and only on opening. The effect used to depend on `stored` as
 * well, which made it fire whenever that object changed *identity* rather than
 * content — so a caller passing an inline `?? {}` reset the rows on every
 * render of its parent, discarding whatever was half-typed.
 *
 * Reading the latest `stored` through a ref rather than listing it as a
 * dependency, because the value wanted here is the one at the moment of
 * opening. Content-comparing it would work too and would still be answering
 * the wrong question: an edit in progress should survive the stored set
 * changing underneath it, not be replaced by it.
 */
export function useRows(
  stored: Record<string, string>,
  open: boolean,
): [Row[], React.Dispatch<React.SetStateAction<Row[]>>] {
  const [rows, setRows] = useState<Row[]>(() => toRows(stored));
  const latest = useRef(stored);
  latest.current = stored;
  useEffect(() => {
    if (open) setRows(toRows(latest.current));
  }, [open]);
  return [rows, setRows];
}
