import { TOUR_SECTIONS, type TourProgress, type TourSection } from "./tour-types.js";

const TOUR_PROGRESS_PREFIX = "todo-list.onboarding.v1.";
const TOUR_SNOOZE_PREFIX = "todo-list.onboarding.snoozed.v1.";

interface ReadableStorage {
  getItem: (key: string) => string | null;
}

interface WritableStorage extends ReadableStorage {
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export function emptyTourProgress(): TourProgress {
  return { version: 1, completedSections: [] };
}

export function tourProgressKey(userId: string): string {
  return `${TOUR_PROGRESS_PREFIX}${userId}`;
}

export function tourSnoozeKey(userId: string): string {
  return `${TOUR_SNOOZE_PREFIX}${userId}`;
}

export function readTourProgress(storage: ReadableStorage, userId: string): TourProgress {
  try {
    const raw = storage.getItem(tourProgressKey(userId));
    if (!raw) return emptyTourProgress();
    const parsed = JSON.parse(raw) as Partial<TourProgress>;
    if (parsed.version !== 1 || !Array.isArray(parsed.completedSections)) {
      return emptyTourProgress();
    }
    const completedSections = [...new Set(
      parsed.completedSections.filter(
        (section): section is TourSection => TOUR_SECTIONS.includes(section as TourSection),
      ),
    )];
    return { version: 1, completedSections };
  } catch {
    return emptyTourProgress();
  }
}

export function writeTourProgress(
  storage: WritableStorage,
  userId: string,
  progress: TourProgress,
): void {
  try {
    storage.setItem(tourProgressKey(userId), JSON.stringify(progress));
  } catch {
    // Browser privacy settings can disable storage; the in-memory controller still works.
  }
}

export function completeTourSection(
  progress: TourProgress,
  section: TourSection,
): TourProgress {
  if (progress.completedSections.includes(section)) return progress;
  return {
    version: 1,
    completedSections: [...progress.completedSections, section],
  };
}

export function clearTourProgress(storage: WritableStorage, userId: string): void {
  try {
    storage.removeItem(tourProgressKey(userId));
  } catch {
    // Keep reset usable even when browser storage is unavailable.
  }
}

export function isTourSnoozed(storage: ReadableStorage, userId: string): boolean {
  try {
    return storage.getItem(tourSnoozeKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function snoozeTours(storage: WritableStorage, userId: string): void {
  try {
    storage.setItem(tourSnoozeKey(userId), "1");
  } catch {
    // The current overlay still closes if session storage is unavailable.
  }
}

export function clearTourSnooze(storage: WritableStorage, userId: string): void {
  try {
    storage.removeItem(tourSnoozeKey(userId));
  } catch {
    // Reset remains best-effort when browser storage is unavailable.
  }
}
