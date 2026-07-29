export const TOUR_SECTIONS = [
  "project-setup",
  "workspace",
  "resources",
  "availability",
] as const;

export type TourSection = (typeof TOUR_SECTIONS)[number];
export type TourEntryView = "gantt" | "resources" | "availability";
export type TourPlacement = "top" | "right" | "bottom" | "left";
export type TourIconName =
  | "calendar"
  | "file"
  | "folder"
  | "gantt"
  | "layers"
  | "plus"
  | "search"
  | "settings"
  | "sparkles"
  | "table"
  | "users";

export interface TourStep {
  id: string;
  title: string;
  description: string;
  targetIds: string[];
  icon: TourIconName;
  placement?: TourPlacement;
  action?: "create-project";
}

export interface TourDefinition {
  section: TourSection;
  title: string;
  description: string;
  entryView?: TourEntryView;
  steps: TourStep[];
}

export interface TourProgress {
  version: 1;
  completedSections: TourSection[];
}

export interface ActiveTour {
  section: TourSection;
  stepIndex: number;
  manual: boolean;
}
