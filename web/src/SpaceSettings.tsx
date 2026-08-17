import { useEffect, useState } from 'react';
import type { NumberRegion, User } from './api';

/**
 * The regions, each labelled with what it actually does to a number.
 *
 * The sample is the label rather than a note beside it, because "Western Europe"
 * on its own does not tell anyone whether their `1.234` is a thousand or a
 * fraction — which is the entire question this setting answers.
 */
const REGIONS: Array<{ id: NumberRegion; label: string }> = [
  { id: 'north-america', label: 'North America — 1,234.56' },
  { id: 'western-europe', label: 'Western Europe — 1.234,56' },
  { id: 'eastern-europe', label: 'Eastern Europe — 1 234,56' },
];

const DEFAULT_REGION: NumberRegion = 'north-america';
const DEFAULT_FPS = 24;

/**
 * The settings that change what a sheet computes.
 *
 * A missing key is not a value of "default" — it means *inherit*, which is what
 * lets an instance define its region once and one space differ from it.
 */
export interface Computed {
  region?: NumberRegion;
  fps?: number;
  zone?: string;
  holidayCountry?: string;
}

/**
 * One tier of the computed settings.
 *
 * The same component serves the space and the Everywhere tier, which is what
 * keeps the two looking and behaving alike. `inherited` is the tier above, or
 * null when this *is* the top: each field then says what it would fall back to,
 * so an empty box never leaves the reader guessing what is actually in force.
 */
function ComputedEditor({
  values,
  inherited,
  holidays,
  onSave,
}: {
  values: Computed;
  inherited: Computed | null;
  holidays: { country: string; count: number } | null;
  onSave(key: keyof Computed, value: string | number | null): void;
}) {
  /** What this field falls back to, worded for the tier it is in. */
  const fallback = (key: keyof Computed, spelled: (v: never) => string): string => {
    if (!inherited) return 'the built-in default';
    const above = inherited[key];
    return above === undefined
      ? 'the built-in default'
      : `Everywhere — ${spelled(above as never)}`;
  };

  const regionLabel = (id: NumberRegion) =>
    REGIONS.find((entry) => entry.id === id)?.label ?? id;

  return (
    <div className="computed-editor">
      <label className="computed-row">
        <span className="computed-label">Number region</span>
        <select
          className="setting-select"
          value={values.region ?? ''}
          onChange={(event) =>
            onSave('region', event.target.value === '' ? null : event.target.value)
          }
        >
          <option value="">Inherit — {fallback('region', regionLabel)}</option>
          {REGIONS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <label className="computed-row">
        <span className="computed-label">Time zone</span>
        <input
          className="setting-select"
          defaultValue={values.zone ?? ''}
          key={`zone-${values.zone ?? ''}`}
          placeholder={`Inherit — ${fallback('zone', (v) => String(v))}`}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next !== (values.zone ?? '')) onSave('zone', next === '' ? null : next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>

      <label className="computed-row">
        <span className="computed-label">Frame rate</span>
        <input
          className="setting-input"
          type="number"
          min="1"
          max="1000"
          defaultValue={values.fps ?? ''}
          key={`fps-${values.fps ?? ''}`}
          placeholder={inherited?.fps ? String(inherited.fps) : String(DEFAULT_FPS)}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            if (raw === '') {
              if (values.fps !== undefined) onSave('fps', null);
              return;
            }
            const next = Number(raw);
            if (!Number.isFinite(next) || next <= 0 || next > 1000) {
              event.target.value = values.fps === undefined ? '' : String(values.fps);
              return;
            }
            if (next !== values.fps) onSave('fps', next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>

      <label className="computed-row">
        <span className="computed-label">Holiday country</span>
        <input
          className="setting-input"
          defaultValue={values.holidayCountry ?? ''}
          key={`country-${values.holidayCountry ?? ''}`}
          maxLength={2}
          placeholder={inherited?.holidayCountry ?? 'US'}
          onBlur={(event) => {
            const next = event.target.value.trim().toUpperCase();
            if (next === '') {
              if (values.holidayCountry !== undefined) onSave('holidayCountry', null);
              return;
            }
            if (!/^[A-Z]{2}$/.test(next)) {
              event.target.value = values.holidayCountry ?? '';
              return;
            }
            if (next !== values.holidayCountry) onSave('holidayCountry', next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>

      {/* What actually loaded, not what was asked for: a code the provider does
          not cover would otherwise surface much later as workday maths counting
          a holiday as a working day. */}
      {holidays && (
        <p className="reference-note">
          {holidays.count === 0
            ? `No holidays loaded for ${holidays.country} — workdays count weekends only.`
            : `${holidays.count} holidays loaded for ${holidays.country}.`}
        </p>
      )}

      <p className="reference-note">
        The region decides how a sheet is <strong>read</strong>: <code>1.234 + 1</code>{' '}
        is 1.235 under Western Europe and 2.234 under North America. Leaving the
        zone empty resolves dates wherever the reader is.
      </p>
    </div>
  );
}

/** One editable global. A list, not a map, so a half-typed row can exist. */
interface Row {
  name: string;
  value: string;
}

export interface SpaceSettingsProps {
  open: boolean;
  /** The space being edited — always the one in use; see below. */
  space: User;
  /** This space's own globals. */
  globals: Record<string, string>;
  /** The globals that apply in every space. */
  sharedGlobals: Record<string, string>;
  /** False when this is the only space, which cannot be removed. */
  canRemove: boolean;
  /** This space's own computed settings. A missing key means it inherits. */
  computed: Computed;
  /** The Everywhere tier every space starts from. */
  sharedComputed: Computed;
  /** The country and holiday count actually in force, as the server reports it. */
  holidays: { country: string; count: number } | null;
  /** Shows what an expression works out to, for the preview beside each row. */
  preview(expression: string): string;
  onRename(name: string): void;
  onSaveGlobals(globals: Record<string, string>): void;
  onSaveSharedGlobals(globals: Record<string, string>): void;
  /** Sets one of this space's own values. `null` clears it back to inheriting. */
  onSaveComputed(key: keyof Computed, value: string | number | null): void;
  /** Sets one Everywhere value. `null` clears it. */
  onSaveSharedComputed(key: keyof Computed, value: string | number | null): void;
  onRemove(): void;
  onClose(): void;
}

function toRows(globals: Record<string, string>): Row[] {
  return Object.entries(globals).map(([name, value]) => ({ name, value }));
}

function named(rows: Row[]): Row[] {
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

function GlobalsEditor({
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
export function SpaceSettings(props: SpaceSettingsProps) {
  const { open, space, globals, sharedGlobals, canRemove, preview } = props;
  const { computed, sharedComputed, holidays } = props;
  const { onRename, onSaveGlobals, onSaveSharedGlobals, onRemove, onClose } = props;
  const { onSaveComputed, onSaveSharedComputed } = props;

  const [name, setName] = useState(space.name);
  const [spaceRows, setSpaceRows] = useState<Row[]>(() => toRows(globals));
  const [sharedRows, setSharedRows] = useState<Row[]>(() => toRows(sharedGlobals));
  // Held as text so the field can be empty mid-edit without snapping to a
  // number the moment a digit is deleted.


  // Reset whenever the panel opens, so a cancelled edit is not still sitting
  // there the next time it is opened.
  useEffect(() => {
    if (!open) return;
    setName(space.name);
    setSpaceRows(toRows(globals));
    setSharedRows(toRows(sharedGlobals));
  }, [open, space.name, space.id, globals, sharedGlobals]);

  if (!open) return null;

  const ownNames = new Set(named(spaceRows).map((row) => row.name.trim()));
  const shadowing: Record<string, string> = {};
  for (const [key, value] of Object.entries(sharedGlobals)) {
    if (ownNames.has(key)) shadowing[key] = value;
  }
  const inherited = Object.entries(sharedGlobals).filter(([key]) => !ownNames.has(key));

  const commitName = () => {
    const next = name.trim();
    if (next === '' || next === space.name) {
      setName(space.name);
      return;
    }
    onRename(next);
  };

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
            <h3>Numbers and time in {space.name}</h3>
            <p className="reference-blurb">
              These change what a sheet <strong>computes</strong>, not how it
              looks. Each follows the Everywhere value until this space sets its
              own.
            </p>
            <ComputedEditor
              values={computed}
              inherited={sharedComputed}
              holidays={holidays}
              onSave={onSaveComputed}
            />
          </section>

          <section className="reference-group">
            <h3>Variables in {space.name}</h3>
            <p className="reference-blurb">
              Available to every sheet in this space, as if each had declared them
              at the top. A sheet can shadow one by declaring the same name itself.
            </p>

            <GlobalsEditor
              rows={spaceRows}
              setRows={setSpaceRows}
              stored={globals}
              preview={preview}
              onSave={onSaveGlobals}
              shadowing={shadowing}
            />

            {inherited.length > 0 && (
              <>
                <p className="reference-note">
                  Also in effect here, from Everywhere:
                </p>
                <div className="globals-editor">
                  {inherited.map(([key, value]) => (
                    <div className="global-row global-row-inherited" key={key}>
                      <span className="global-inherited-name">{key}</span>
                      <span className="global-inherited-value">{value}</span>
                      <span className="global-answer" title={preview(value)}>
                        {preview(value) || '—'}
                      </span>
                      {/* Copies the value in as this space's own, which is the
                          only way to differ from Everywhere without editing it
                          for every other space too. */}
                      <button
                        type="button"
                        className="ghost"
                        title={`Give ${space.name} its own ${key}`}
                        onClick={() =>
                          setSpaceRows((current) => [...current, { name: key, value }])
                        }
                      >
                        Override
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="reference-group">
            <h3>Variables everywhere</h3>
            <p className="reference-blurb">
              In effect in <strong>every</strong> space, so a rate you use in all of
              them is defined once. Any space can override one by name, which leaves
              the others as they were.
            </p>
            <p className="reference-note">
              This is the one thing here that reaches past the space you are in, and
              the app has no passwords — anyone who can open it can change these.
            </p>

            <GlobalsEditor
              rows={sharedRows}
              setRows={setSharedRows}
              stored={sharedGlobals}
              preview={preview}
              onSave={onSaveSharedGlobals}
            />

            <h3>Numbers and time everywhere</h3>
            <p className="reference-blurb">
              The values every space starts from. Set the region once here rather
              than once per space; a space that needs to differ overrides it above.
            </p>
            <ComputedEditor
              values={sharedComputed}
              inherited={null}
              holidays={null}
              onSave={onSaveSharedComputed}
            />
          </section>

          <section className="reference-group">
            <h3>Other spaces</h3>
            <p className="reference-blurb">
              This panel edits the space you are working in. To change another one’s
              own variables, switch to it first — its sheets, folders and variables
              are only reachable from inside it.
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
