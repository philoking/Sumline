import type { EngineOptions, NumberRegion } from './types.js';

/**
 * The computed settings in their two tiers, as a host resolves them.
 *
 * "Computed" means the setting changes what a sheet *answers*, not how the app
 * around it is arranged — which is what earns a setting a place in this file.
 */
export interface ComputedSettings {
  region?: NumberRegion;
  zone?: string;
}

/**
 * The stored settings this function reads, as a host hands them over.
 *
 * The index signature is not laziness: the settings store is deliberately
 * free-form — the README documents writing it with `curl`, and most of what is
 * in it (which statistic the corner shows, how the sidebar is ordered, the text
 * size) is the app's business and never reaches here. Naming only the keys that
 * do is the whole point of the type.
 */
export interface EngineSettings {
  region?: NumberRegion;
  zone?: string;
  precision?: number;
  largeNumberNotation?: boolean;
  thousandsSeparators?: boolean;
  currencyRounding?: boolean;
  /** This space's own globals. */
  globals?: Record<string, string>;
  /** The globals of every tier resolved together, if the host resolved them. */
  effectiveGlobals?: Record<string, string>;
  /** The computed settings of every tier resolved together. */
  effective?: ComputedSettings;
  [key: string]: unknown;
}

/**
 * Which of a host's settings reach the engine, in one place.
 *
 * This function exists because the answer was once wrong and nothing noticed:
 * `region` was an engine option, was implemented, was documented in the README —
 * and was never passed, so European number formats did not exist however the
 * setting was written. A spread buried in a hook argument is easy to write and
 * impossible to test; a named function is neither.
 *
 * It lives in the engine rather than in the app that first needed it because
 * there is now more than one host: the browser builds a sheet's engine from a
 * space's settings, and `POST /api/evaluate` builds one from the same settings
 * on the server. A second copy of this mapping is a second answer to "what does
 * this space compute", and the whole point of that endpoint is that a launcher
 * and a sheet agree.
 *
 * Only settings that change what a sheet **computes** belong here. The rest —
 * which statistic the corner shows, whether the total is visible, how the
 * sidebar is ordered — are the app's business and never reach the engine.
 */
export function engineOptionsFrom(settings: EngineSettings): EngineOptions {
  /*
   * The resolved view the host computed, not this space's own globals: the
   * server owns precedence between the space and Everywhere, so that it is
   * decided once rather than by whichever client is merging.
   */
  const globals = settings.effectiveGlobals ?? settings.globals;

  /*
   * The resolved tier, not this space's own keys. A space that has not
   * overridden the region must still get the instance-wide one, and deciding
   * that here rather than reading `settings.region` is what makes an Everywhere
   * value actually reach the sheets.
   */
  const computed: ComputedSettings = settings.effective ?? {
    ...(settings.region && { region: settings.region }),
    ...(settings.zone && { zone: settings.zone }),
  };

  return {
    // Absent means on, matching the View menu's default.
    largeNumberNotation: settings.largeNumberNotation !== false,
    thousandsSeparators: settings.thousandsSeparators !== false,
    currencyRounding: settings.currencyRounding !== false,
    // Left off when unset so the engine applies its own default rather than
    // this layer keeping a second copy of what that default is.
    ...(settings.precision !== undefined && { precision: settings.precision }),
    ...(globals && { globals }),
    // Left off entirely when unset, so the engine applies its own default
    // rather than this layer keeping a second copy of what that default is.
    ...(computed.region && { region: computed.region }),
    ...(computed.zone && { zone: computed.zone }),
  };
}
