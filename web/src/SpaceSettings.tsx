import { useEffect, useState } from 'react';
import type { User } from './api';

/** One editable global. Kept as a list so a half-typed row can exist. */
interface Row {
  name: string;
  value: string;
}

export interface SpaceSettingsProps {
  open: boolean;
  /** The space being edited — always the one in use; see below. */
  space: User;
  globals: Record<string, string>;
  /** False when this is the only space, which cannot be removed. */
  canRemove: boolean;
  /** Shows what an expression works out to, for the preview beside each row. */
  preview(expression: string): string;
  onRename(name: string): void;
  onSaveGlobals(globals: Record<string, string>): void;
  onRemove(): void;
  onClose(): void;
}

function toRows(globals: Record<string, string>): Row[] {
  return Object.entries(globals).map(([name, value]) => ({ name, value }));
}

/**
 * Everything about one space in one place.
 *
 * Only the space currently in use can be edited, because the settings API is
 * scoped by the same cookie that decides which sheets you see. Editing another
 * space means switching to it first — said out loud in the panel rather than
 * left for the reader to infer from a name that does not match the switcher.
 */
export function SpaceSettings(props: SpaceSettingsProps) {
  const { open, space, globals, canRemove, preview } = props;
  const { onRename, onSaveGlobals, onRemove, onClose } = props;

  const [name, setName] = useState(space.name);
  const [rows, setRows] = useState<Row[]>(() => toRows(globals));

  // Reset whenever the panel opens, so a cancelled edit is not still sitting
  // there the next time it is opened.
  useEffect(() => {
    if (!open) return;
    setName(space.name);
    setRows(toRows(globals));
  }, [open, space.name, space.id, globals]);

  if (!open) return null;

  const named = rows.filter((row) => row.name.trim() !== '');
  const duplicate = named.some(
    (row, index) =>
      named.findIndex((other) => other.name.trim() === row.name.trim()) !== index,
  );

  const commitName = () => {
    const next = name.trim();
    if (next === '' || next === space.name) {
      setName(space.name);
      return;
    }
    onRename(next);
  };

  const save = () => {
    if (duplicate) return;
    // Rebuilt from the rows rather than merged into what was there, which is
    // how the server stores it: globals is one value, so a save is a
    // replacement and deleting a row here has to mean deleting the variable.
    const next: Record<string, string> = {};
    for (const row of rows) {
      const key = row.name.trim();
      if (key !== '') next[key] = row.value.trim();
    }
    onSaveGlobals(next);
  };

  const dirty =
    JSON.stringify(toRows(globals)) !==
    JSON.stringify(rows.filter((row) => row.name.trim() !== ''));

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <aside className="reference space-settings" aria-label={`${space.name} settings`}>
        <header className="reference-head">
          <strong>Space settings</strong>
          <button type="button" className="ghost" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="reference-body">
          <section className="reference-group">
            <h3>Name</h3>
            <input
              className="space-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setName(space.name);
              }}
              aria-label="Space name"
            />
            <p className="reference-note">
              Renaming changes only what is shown. Every sheet stays where it is,
              because they are filed under this space’s id (<code>{space.id}</code>),
              not its name.
            </p>
          </section>

          <section className="reference-group">
            <h3>Global variables</h3>
            <p className="reference-blurb">
              Available to every sheet in <strong>{space.name}</strong>, as if each
              had been declared at the top. A sheet can shadow one by declaring the
              same name itself.
            </p>

            <div className="globals-editor">
              {rows.map((row, index) => {
                const answer = row.value.trim() === '' ? '' : preview(row.value);
                return (
                  <div className="global-row" key={index}>
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
                );
              })}

              {rows.length === 0 && (
                <p className="reference-note">
                  None yet. Add one and every sheet in this space can use it.
                </p>
              )}
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
                onClick={save}
              >
                {dirty ? 'Save variables' : 'Saved'}
              </button>
            </div>

            {duplicate && (
              <p className="reference-note global-warning">
                Two variables share a name. Only one of them could ever win, so
                nothing is saved until that is settled.
              </p>
            )}
          </section>

          <section className="reference-group">
            <h3>Other spaces</h3>
            <p className="reference-blurb">
              This panel edits the space you are working in. To change another one’s
              variables, switch to it first — its sheets, folders and variables are
              only reachable from inside it.
            </p>

            <h3>Remove</h3>
            <p className="reference-blurb">
              Removing <strong>{space.name}</strong> keeps its sheets. Nothing owns
              them afterwards so they drop out of every list, and adding a space back
              under the same name shows them again.
            </p>
            <button
              type="button"
              className="danger-button"
              disabled={!canRemove}
              onClick={onRemove}
              title={
                canRemove ? `Remove ${space.name}` : 'The last space cannot be removed'
              }
            >
              Remove this space
            </button>
          </section>
        </div>
      </aside>
    </>
  );
}
