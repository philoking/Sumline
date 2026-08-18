import { describe, expect, it } from 'vitest';
import { formatShortcut, isApplePlatform } from '../src/shortcuts';

describe('isApplePlatform', () => {
  it('recognises what the platform APIs actually report', () => {
    // `userAgentData.platform` says macOS; the deprecated `navigator.platform`
    // says MacIntel — including on an iPad, which reports itself as a Mac.
    expect(isApplePlatform('macOS')).toBe(true);
    expect(isApplePlatform('MacIntel')).toBe(true);
    expect(isApplePlatform('iPhone')).toBe(true);
  });

  it('does not claim Windows or Linux', () => {
    expect(isApplePlatform('Windows')).toBe(false);
    expect(isApplePlatform('Win32')).toBe(false);
    expect(isApplePlatform('Linux x86_64')).toBe(false);
    // No hint at all is the case under a bare test runner, and the spelled-out
    // modifier is the safer thing to show when we cannot tell.
    expect(isApplePlatform('')).toBe(false);
  });
});

describe('formatShortcut', () => {
  it('resolves Mod to the key that is actually on the keyboard', () => {
    // The whole of #78: `Mod + F` names a key neither platform has.
    expect(formatShortcut(['Mod', 'F'], true)).toBe('⌘ + F');
    expect(formatShortcut(['Mod', 'F'], false)).toBe('Ctrl + F');
  });

  it('separates the keys the same way on both platforms', () => {
    // #103: the joined Apple spelling (⌘⇧U) is native to a menu bar and
    // illegible in a table, where the reader is being told the shortcut rather
    // than reminded of it.
    expect(formatShortcut(['Mod', 'Shift', 'U'], true)).toBe('⌘ + ⇧ + U');
    expect(formatShortcut(['Mod', 'Shift', 'U'], false)).toBe('Ctrl + Shift + U');
  });

  it('leaves punctuation keys alone', () => {
    expect(formatShortcut(['Mod', '\\'], true)).toBe('⌘ + \\');
    expect(formatShortcut(['Mod', '/'], false)).toBe('Ctrl + /');
    // A single key has nothing to separate it from, on either platform.
    expect(formatShortcut(['?'], true)).toBe('?');
  });

  it('names the keys that have no symbol on a PC keyboard', () => {
    expect(formatShortcut(['Enter'], true)).toBe('↵');
    expect(formatShortcut(['Enter'], false)).toBe('Enter');
    expect(formatShortcut(['Escape'], false)).toBe('Esc');
  });
});
