import { describe, expect, it } from "vitest";

import {
  readSidebarPreference,
  readThemePreference,
  resolveTheme,
  SIDEBAR_STORAGE_KEY,
  THEME_STORAGE_KEY,
  writeSidebarPreference,
  writeThemePreference,
} from "../../src/lib/ui-preferences.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("UI preferences", () => {
  it("resolves the system preference against the current media setting", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("falls back when stored values are invalid", () => {
    const storage = memoryStorage({
      [THEME_STORAGE_KEY]: "sepia",
      [SIDEBAR_STORAGE_KEY]: "hidden",
    });
    expect(readThemePreference(storage)).toBe("system");
    expect(readSidebarPreference(storage)).toBe("expanded");
  });

  it("persists supported theme and sidebar choices", () => {
    const storage = memoryStorage();
    writeThemePreference(storage, "dark");
    writeSidebarPreference(storage, "collapsed");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(storage.values.get(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
  });

  it("keeps defaults when browser storage is unavailable", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(blockedStorage)).toBe("system");
    expect(readSidebarPreference(blockedStorage)).toBe("expanded");
    expect(() => writeThemePreference(blockedStorage, "dark")).not.toThrow();
  });
});
