export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type SidebarPreference = "expanded" | "collapsed";

export const THEME_STORAGE_KEY = "todo-list.theme.v1";
export const SIDEBAR_STORAGE_KEY = "todo-list.sidebar.v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function readThemePreference(
  storage?: ReadableStorage,
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

export function writeThemePreference(
  storage: WritableStorage | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function readSidebarPreference(
  storage?: ReadableStorage,
): SidebarPreference {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "collapsed"
      ? "collapsed"
      : "expanded";
  } catch {
    return "expanded";
  }
}

export function writeSidebarPreference(
  storage: WritableStorage | undefined,
  preference: SidebarPreference,
): void {
  try {
    storage?.setItem(SIDEBAR_STORAGE_KEY, preference);
  } catch {
    // A failed preference write must not block the workspace.
  }
}
