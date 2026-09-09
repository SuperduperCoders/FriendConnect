import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const THEMES = [
  { id: 'violet', name: 'Violet', emoji: '💜' },
  { id: 'ocean', name: 'Ocean', emoji: '🌊' },
  { id: 'sunset', name: 'Sunset', emoji: '🌅' },
  { id: 'forest', name: 'Forest', emoji: '🌲' },
  { id: 'candy', name: 'Candy', emoji: '🍬' },
  { id: 'dark', name: 'Dark', emoji: '🌙' },
  { id: 'galaxy', name: 'Galaxy', emoji: '🌌' },
  { id: 'midnight', name: 'Midnight', emoji: '🌑' },
  { id: 'rosegold', name: 'Rose Gold', emoji: '🌹' },
  { id: 'neon', name: 'Cyber', emoji: '⚡' },
  { id: 'arctic', name: 'Arctic', emoji: '❄️' },
  { id: 'cherry', name: 'Cherry', emoji: '🌸' },
  { id: 'deep_ocean', name: 'Deep Ocean', emoji: '🐳' },
  { id: 'lava', name: 'Lava', emoji: '🌋' },
  { id: 'amoled', name: 'Dark', emoji: '⬛' },
];

interface ThemeCtx {
  theme: string; setTheme: (id: string) => void;
  themes: typeof THEMES; isDark: boolean;
}

const Ctx = createContext<ThemeCtx>(null!);
export function useTheme() { return useContext(Ctx); }

const DARK_THEMES = ['dark', 'galaxy', 'midnight', 'neon', 'amoled'];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState(() => localStorage.getItem('fc_theme') || 'violet');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fc_theme', theme);
  }, [theme]);

  const setTheme = (id: string) => setThemeState(id);
  const isDark = DARK_THEMES.includes(theme);

  return (
    <Ctx.Provider value={{ theme, setTheme, themes: THEMES, isDark }}>
      {children}
    </Ctx.Provider>
  );
}
