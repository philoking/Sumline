import { useCallback, useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'webcalc.theme';
const ORDER: Theme[] = ['system', 'light', 'dark'];

/**
 * The appearance setting.
 *
 * Kept in localStorage rather than the server settings that hold the other
 * preferences: which theme suits you is a property of the screen you are
 * sitting at, not of your sheets. A phone in a dark room and a desktop by a
 * window should not have to agree.
 */
export function useTheme(): {
  theme: Theme;
  cycle: () => void;
  label: string;
  icon: string;
} {
  const [theme, setTheme] = useState<Theme>(() => read());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
      // Let the browser pick native control and scrollbar colours too.
      root.style.colorScheme = 'light dark';
    } else {
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme;
    }
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!);
  }, []);

  return {
    theme,
    cycle,
    label: LABELS[theme],
    icon: ICONS[theme],
  };
}

const LABELS: Record<Theme, string> = {
  system: 'Appearance follows your system — click for light',
  light: 'Light appearance — click for dark',
  dark: 'Dark appearance — click to follow your system',
};

const ICONS: Record<Theme, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

function read(): Theme {
  // `?theme=light` sets it directly, so an appearance can be linked to.
  const requested = new URLSearchParams(window.location.search).get('theme');
  if (isTheme(requested)) return requested;

  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : 'system';
}

function isTheme(value: string | null): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}
