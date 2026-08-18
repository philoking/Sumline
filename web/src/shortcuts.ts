/**
 * How a shortcut is written for the person reading it.
 *
 * `Mod` is CodeMirror's name for "⌘ on an Apple keyboard, Ctrl everywhere
 * else". It is the right thing to bind against — one binding, both platforms —
 * but the wrong thing to print: a reader on Windows told to press `Mod + F` has
 * to guess which key that is. So the bindings go on saying Mod, and only the
 * rendering resolves it.
 *
 * Each platform keeps its own key names — the glyphs printed on an Apple
 * keyboard, the words printed everywhere else — and both are joined with the
 * same `+`.
 *
 * A Mac conventionally runs its symbols together (⌘⇧U), and this deliberately
 * does not. Set in a reference table rather than a menu bar, three unfamiliar
 * glyphs with nothing between them read as one character nobody can name; the
 * separator says how many keys are being asked for. Legibility wins over the
 * platform idiom here, because the table exists to be read by someone who does
 * not already know the shortcut.
 */

/** Symbols on an Apple keyboard, which are printed on the keys themselves. */
const APPLE_KEYS: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Enter: '↵',
  Escape: '⎋',
};

/** Names elsewhere, where the keys carry words rather than glyphs. */
const OTHER_KEYS: Record<string, string> = {
  Mod: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Ctrl: 'Ctrl',
  Enter: 'Enter',
  Escape: 'Esc',
};

/**
 * What the browser says it is running on.
 *
 * `userAgentData` first because `navigator.platform` is deprecated and already
 * frozen in some browsers, and the user agent string last because it is the
 * only one guaranteed to exist. Absent entirely under a bare test runner, where
 * an empty hint correctly resolves to the non-Apple spelling.
 */
function platformHint(): string {
  if (typeof navigator === 'undefined') return '';
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  return agent.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? '';
}

/**
 * Whether this keyboard has a ⌘ key.
 *
 * iPads report themselves as a Mac and can have a hardware keyboard, so the
 * whole Apple family is treated the same way rather than desktop macOS alone.
 */
export function isApplePlatform(hint: string = platformHint()): boolean {
  return /mac|iphone|ipad|ipod/i.test(hint);
}

/**
 * Renders a binding — `['Mod', 'Shift', 'U']` — as this platform writes it.
 *
 * The parts are the same names CodeMirror's `keymap` accepts, so the table in
 * the reference panel and the bindings it documents are written from one
 * vocabulary and cannot drift apart.
 */
export function formatShortcut(
  keys: readonly string[],
  apple: boolean = isApplePlatform(),
): string {
  const named = apple ? APPLE_KEYS : OTHER_KEYS;
  return keys.map((key) => named[key] ?? key.toUpperCase()).join(' + ');
}
