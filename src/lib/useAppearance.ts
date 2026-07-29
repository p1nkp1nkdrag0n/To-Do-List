import { useEffect, useMemo, useState } from "react";

import {
  readSidebarPreference,
  readThemePreference,
  resolveTheme,
  writeSidebarPreference,
  writeThemePreference,
  type ResolvedTheme,
  type SidebarPreference,
  type ThemePreference,
} from "./ui-preferences";

export interface AppearanceController {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  sidebarPreference: SidebarPreference;
  setThemePreference: (preference: ThemePreference) => void;
  toggleSidebar: () => void;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function useAppearance(): AppearanceController {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(
    () => readThemePreference(browserStorage()),
  );
  const [sidebarPreference, setSidebarPreference] = useState<SidebarPreference>(
    () => readSidebarPreference(browserStorage()),
  );
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolvedTheme = useMemo(
    () => resolveTheme(themePreference, systemDark),
    [systemDark, themePreference],
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.sidebar = sidebarPreference;
    document.documentElement.style.colorScheme = resolvedTheme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedTheme === "dark" ? "#0b1118" : "#f3f6fa");
  }, [resolvedTheme, sidebarPreference]);

  const setThemePreference = (preference: ThemePreference) => {
    setThemePreferenceState(preference);
    writeThemePreference(browserStorage(), preference);
  };

  const toggleSidebar = () => {
    setSidebarPreference((current) => {
      const next = current === "expanded" ? "collapsed" : "expanded";
      writeSidebarPreference(browserStorage(), next);
      return next;
    });
  };

  return {
    themePreference,
    resolvedTheme,
    sidebarPreference,
    setThemePreference,
    toggleSidebar,
  };
}
