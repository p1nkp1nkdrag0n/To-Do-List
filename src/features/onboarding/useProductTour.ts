import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkspaceView } from "../../components/AppShell";
import { tourDefinition } from "./tour-definitions";
import {
  clearTourProgress,
  clearTourSnooze,
  completeTourSection,
  emptyTourProgress,
  isTourSnoozed,
  readTourProgress,
  snoozeTours,
  writeTourProgress,
} from "./tour-storage";
import type { ActiveTour, TourProgress, TourSection } from "./tour-types";

interface UseProductTourOptions {
  userId?: string;
  enabled: boolean;
  hasProject: boolean;
  activeView: WorkspaceView;
  autoStartBlocked: boolean;
}

export interface TourController {
  active?: ActiveTour;
  progress: TourProgress;
  viewportSupported: boolean;
  start: (section: TourSection, manual?: boolean) => void;
  pauseForAction: () => void;
  previous: () => void;
  next: () => void;
  skipSection: () => void;
  snooze: () => void;
  completeSection: (section: TourSection) => void;
  resetAll: () => void;
}

function automaticSection(
  hasProject: boolean,
  activeView: WorkspaceView,
): TourSection {
  if (!hasProject) return "project-setup";
  return activeView === "gantt" ? "workspace" : activeView;
}

export function useProductTour({
  userId,
  enabled,
  hasProject,
  activeView,
  autoStartBlocked,
}: UseProductTourOptions): TourController {
  const [progress, setProgress] = useState<TourProgress>(emptyTourProgress);
  const [readyUserId, setReadyUserId] = useState<string>();
  const [active, setActive] = useState<ActiveTour>();
  const [snoozed, setSnoozed] = useState(false);
  const [viewportSupported, setViewportSupported] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches,
  );
  const contextKey = `${hasProject ? activeView : "project-setup"}:${hasProject ? "project" : "empty"}`;
  const [resetHoldContext, setResetHoldContext] = useState<string>();

  useEffect(() => {
    if (!userId) {
      setProgress(emptyTourProgress());
      setReadyUserId(undefined);
      setActive(undefined);
      setSnoozed(false);
      return;
    }
    setProgress(readTourProgress(window.localStorage, userId));
    setSnoozed(isTourSnoozed(window.sessionStorage, userId));
    setReadyUserId(userId);
    setActive(undefined);
    setResetHoldContext(undefined);
  }, [userId]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const update = () => setViewportSupported(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (resetHoldContext !== undefined && resetHoldContext !== contextKey) {
      setResetHoldContext(undefined);
    }
  }, [contextKey, resetHoldContext]);

  const persistCompletion = useCallback((section: TourSection) => {
    setProgress((current) => {
      const next = completeTourSection(current, section);
      if (userId) writeTourProgress(window.localStorage, userId, next);
      return next;
    });
  }, [userId]);

  const start = useCallback((section: TourSection, manual = false) => {
    setActive({ section, stepIndex: 0, manual });
  }, []);

  useEffect(() => {
    if (
      !enabled
      || !userId
      || readyUserId !== userId
      || !viewportSupported
      || autoStartBlocked
      || active
      || resetHoldContext === contextKey
      || snoozed
    ) {
      return;
    }
    const section = automaticSection(hasProject, activeView);
    if (progress.completedSections.includes(section)) return;
    const timer = window.setTimeout(() => {
      setActive((current) => current ?? { section, stepIndex: 0, manual: false });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    active,
    activeView,
    autoStartBlocked,
    contextKey,
    enabled,
    hasProject,
    progress.completedSections,
    readyUserId,
    resetHoldContext,
    snoozed,
    userId,
    viewportSupported,
  ]);

  const pauseForAction = useCallback(() => setActive(undefined), []);

  const previous = useCallback(() => {
    setActive((current) => current
      ? { ...current, stepIndex: Math.max(0, current.stepIndex - 1) }
      : current);
  }, []);

  const next = useCallback(() => {
    if (!active) return;
    const definition = tourDefinition(active.section);
    if (active.stepIndex < definition.steps.length - 1) {
      setActive({ ...active, stepIndex: active.stepIndex + 1 });
      return;
    }
    persistCompletion(active.section);
    setActive(undefined);
  }, [active, persistCompletion]);

  const skipSection = useCallback(() => {
    if (!active) return;
    persistCompletion(active.section);
    setActive(undefined);
  }, [active, persistCompletion]);

  const snooze = useCallback(() => {
    if (userId) snoozeTours(window.sessionStorage, userId);
    setSnoozed(true);
    setActive(undefined);
  }, [userId]);

  const completeSection = useCallback((section: TourSection) => {
    persistCompletion(section);
    setActive((current) => current?.section === section ? undefined : current);
  }, [persistCompletion]);

  const resetAll = useCallback(() => {
    if (userId) {
      clearTourProgress(window.localStorage, userId);
      clearTourSnooze(window.sessionStorage, userId);
    }
    setProgress(emptyTourProgress());
    setSnoozed(false);
    setActive(undefined);
    setResetHoldContext(contextKey);
  }, [contextKey, userId]);

  return useMemo(() => ({
    active,
    progress,
    viewportSupported,
    start,
    pauseForAction,
    previous,
    next,
    skipSection,
    snooze,
    completeSection,
    resetAll,
  }), [
    active,
    completeSection,
    next,
    pauseForAction,
    previous,
    progress,
    resetAll,
    skipSection,
    snooze,
    start,
    viewportSupported,
  ]);
}
