'use client';

/**
 * 테마(light/dark) 관리 Provider.
 *
 * 시스템 설정 감지 + 사용자 수동 토글을 지원한다.
 * 선택된 테마는 localStorage에 저장되어 재방문 시 유지된다.
 * <html> 요소에 class="dark"를 토글하여 Tailwind dark: variant를 활성화한다.
 *
 * FOUC(Flash of Unstyled Content) 방지:
 *   layout.tsx의 <head>에 인라인 스크립트를 삽입하여
 *   React 하이드레이션 전에 class="dark"를 설정한다.
 */

import { createContext, useContext, useCallback, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolvedTheme: 'dark',
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'steam-review-feed-theme';

// --- 외부 스토어: localStorage + matchMedia ---

let listeners: Array<() => void> = [];

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  // OS 테마 변경 시 DOM도 동기화
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = () => {
    const theme = getSnapshot();
    if (theme === 'system') applyThemeToDOM(getSystemTheme());
    listener();
  };
  mq.addEventListener('change', handleChange);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener('change', handleChange);
  };
}

/** 유효한 테마 값 집합 */
const VALID_THEMES = new Set<Theme>(['light', 'dark', 'system']);

function getSnapshot(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  // localStorage가 조작되어 잘못된 값이 있을 수 있으므로 검증
  return stored && VALID_THEMES.has(stored as Theme) ? (stored as Theme) : 'system';
}

function getServerSnapshot(): Theme {
  return 'system';
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  if (theme === 'system') return getSystemTheme();
  return theme;
}

function applyThemeToDOM(resolved: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const resolvedTheme = typeof window !== 'undefined' ? resolveTheme(theme) : 'dark';

  const setTheme = useCallback((newTheme: Theme) => {
    localStorage.setItem(STORAGE_KEY, newTheme);
    applyThemeToDOM(resolveTheme(newTheme));
    emitChange();
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
