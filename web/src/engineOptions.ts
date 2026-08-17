import type { EngineOptions } from '@webcalc/engine';
import type { Settings } from './api';

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
export interface EngineInputs extends EngineOptions {
  /**
   * Not an engine option — the holidays themselves are.
   *
   * It belongs here anyway because it is a setting that changes what a sheet
   * computes, and the layer that builds the engine is what has to notice it
   * changed and fetch the right calendar.
   */
  holidayCountry?: string;
}

export function engineOptionsFrom(settings: Settings): EngineInputs {
  /*
   * The resolved view the server computed, not this space's own globals: the
   * server owns precedence between the space and Everywhere, so that it is
   * decided once rather than by whichever client is merging.
   */
  const globals = settings.effectiveGlobals ?? settings.globals;

  return {
    // Absent means on, matching the toolbar's default.
    largeNumberNotation: settings.largeNumberNotation !== false,
    ...(globals && { globals }),
    // Left off entirely when unset, so the engine applies its own default
    // rather than this layer keeping a second copy of what that default is.
    ...(settings.region && { region: settings.region }),
    ...(settings.fps !== undefined && { fps: settings.fps }),
    ...(settings.zone && { zone: settings.zone }),
    ...(settings.holidayCountry && { holidayCountry: settings.holidayCountry }),
  };
}
