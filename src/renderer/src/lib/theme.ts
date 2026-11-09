import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

function read(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch (err) {
    console.warn('[theme] localStorage unavailable; theme not persisted', (err as Error).message);
  }
}

export function useTheme(): [Theme, (next: Theme) => void, () => void] {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    apply(theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return [theme, setTheme, toggle];
}
