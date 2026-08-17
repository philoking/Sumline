import type { ReactNode } from 'react';

/**
 * One setting, as one control.
 *
 * Variables get a whole editor because they are a *list* — many named rows that
 * need room. A single setting is not a list, so it gets a single field, and the
 * scope it belongs to is expressed by which panel it appears in rather than by
 * duplicating the field.
 *
 * `inheritLabel` names what an empty field falls back to — the instance value in
 * the space panel, the built-in default in the global one — which is what makes
 * "not set" legible without a second field to compare against.
 */
export function SettingField({
  label,
  blurb,
  value,
  inheritLabel,
  options,
  onSave,
  autoFocus = false,
}: {
  label: string;
  blurb: ReactNode;
  value: string | undefined;
  inheritLabel: string;
  /** Fixed choices, or undefined for a free-text setting. */
  options?: Array<{ id: string; label: string }>;
  onSave(value: string | null): void;
  /**
   * Marks this as where a panel should put focus when it opens. Not React's
   * `autoFocus`: the panel decides, once, on open — see useDialog.
   */
  autoFocus?: boolean;
}) {
  const focusMarker = autoFocus ? { 'data-autofocus': true } : {};

  return (
    <section className="reference-group">
      <h3>{label}</h3>
      <p className="reference-blurb">{blurb}</p>
      {options ? (
        <select
          className="setting-select"
          {...focusMarker}
          value={value ?? ''}
          aria-label={label}
          onChange={(event) =>
            onSave(event.target.value === '' ? null : event.target.value)
          }
        >
          <option value="">{inheritLabel}</option>
          {options.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="setting-select"
          {...focusMarker}
          defaultValue={value ?? ''}
          key={value ?? ''}
          aria-label={label}
          placeholder={inheritLabel}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next !== (value ?? '')) onSave(next === '' ? null : next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
    </section>
  );
}

export const REGIONS: Array<{ id: string; label: string }> = [
  { id: 'north-america', label: 'North America — 1,234.56' },
  { id: 'western-europe', label: 'Western Europe — 1.234,56' },
  { id: 'eastern-europe', label: 'Eastern Europe — 1 234,56' },
];

export const DEFAULT_REGION_LABEL = REGIONS[0]!.label;

export const regionLabel = (id: string | undefined): string =>
  REGIONS.find((entry) => entry.id === id)?.label ?? DEFAULT_REGION_LABEL;
