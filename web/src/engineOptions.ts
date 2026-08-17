import type { EngineOptions } from '@webcalc/engine';
import type { Computed, Settings } from './api';

/**
 * Which of a space's settings reach the engine, in one place.
 *
 * This function exists because the answer was once wrong and nothing noticed:
 * `region` was an engine option, was implemented, was documented in the README —
 * and was never passed, so European number formats did not exist however the
 * setting was written. A spread buried in a hook argument is easy to write and
 * impossible to test; a named function is neither.
 *
 * Only settings that change what a sheet **computes** belong here. The rest —
 * which statistic the corner shows, whether the total is visible, how the
 * sidebar is ordered — are the app's business and never reach the engine.
 */
export function engineOptionsFrom(settings: Settings): EngineOptions {
  /*
   * The resolved view the server computed, not this space's own globals: the
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
  const computed: Computed = settings.effective ?? {
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
