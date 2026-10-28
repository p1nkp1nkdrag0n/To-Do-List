import { lazy, Suspense, useCallback, useEffect, useState, useRef } from "react";
import { Archive, LoaderCircle, Plus } from "lucide-react";

import { AppShell, type WorkspaceView } from "./components/AppShell";
import { BrandMark } from "./components/BrandMark";
import { AuthScreen } from "./features/auth/AuthScreen";
import { DemoTutorial, DEMO_TOUR_KEY } from "./features/help/DemoTutorial";
import { HelpDialog } from "./features/help/HelpDialog";
import { ProductTour } from "./features/onboarding/ProductTour";
import { tourDefinition } from "./features/onboarding/tour-definitions";
import type { TourSection } from "./features/onboarding/tour-types";
import { useProductTour } from "./features/onboarding/useProductTour";
import { CreateProjectDialog, InviteDialog, RedeemInviteScreen } from "./features/projects/ProjectDialogs";
import { RegistrationInvitesDialog } from "./features/team/RegistrationInvitesDialog";
import { ProjectSettingsDialog } from "./features/projects/ProjectSettingsDialog";
import { api, ApiError, errorMessage } from "./lib/api";
import { useAppearance } from "./lib/useAppearance";
import { useCollaboration } from "./lib/useCollaboration";
import type { AuthState, Project, ProjectDetail, TeamMember } from "./types";

const ACTIVE_PROJECT_KEY = "yancheng.activeProject.v2";
const GanttView = lazy(() => import("./features/gantt/GanttView").then((module) => ({ default: module.GanttView })));
const ResourceLibrary = lazy(() => import("./features/resources/ResourceLibrary").then((module) => ({ default: module.ResourceLibrary })));
const AvailabilityView = lazy(() => import("./features/availability/AvailabilityView").then((module) => ({ default: module.AvailabilityView })));
const MeetingView = lazy(() => import("./features/meeting/MeetingView").then((module) => ({ default: module.MeetingView })));

export default function App() {
  const appearance = useAppearance();
  const [auth, setAuth] = useState<AuthState>();
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectDetail>();
  // 默认落在「会议」：先由会议纪要生成排期，再去看甘特图。
  const [activeView, setActiveView] = useState<WorkspaceView>("meeting");
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showRegistrationInvites, setShowRegistrationInvites] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const collaboration = useCollaboration(activeProject?.project.id, auth?.user.id);
  const tour = useProductTour({
    userId: auth?.user.id,
    enabled: Boolean(auth?.teamMember),
    hasProject: Boolean(activeProject),
    activeView,
    autoStartBlocked: showCreateProject || showInvite || showProjectSettings,
  });

  const loadProject = useCallback(async (projectId: string) => {
    const detail = await api.get<ProjectDetail>(`/api/projects/${projectId}`);
    setActiveProject(detail);
    localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  }, []);

  // 第一次进入系统必须先看完（或跳过）演示教程，之后才轮到分步引导。
  const [tutorialDone, setTutorialDone] = useState(() => {
    try {
      return window.localStorage.getItem(DEMO_TOUR_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (auth !== undefined && !tutorialDone) setShowTutorial(true);
  }, [auth, tutorialDone]);

  const finishTutorial = useCallback(() => {
    try {
      window.localStorage.setItem(DEMO_TOUR_KEY, "1");
    } catch {
      // 隐私模式下存不进去，本次关闭即可。
    }
    setShowTutorial(false);
    setTutorialDone(true);
  }, []);

  // 工作区分步引导的步骤都在甘特图上；刚进入这一段时切过去一次即可，
  // 之后用户自己切到别的页面不能再被强行拉回来。
  const forcedGanttRef = useRef(false);
  useEffect(() => {
    if (tour.active?.section !== "workspace" || !tour.viewportSupported) {
      forcedGanttRef.current = false;
      return;
    }
    if (forcedGanttRef.current) return;
    forcedGanttRef.current = true;
    setActiveView((current) => (current === "gantt" ? current : "gantt"));
  }, [tour.active?.section, tour.viewportSupported]);

  const loadWorkspace = useCallback(async (preferredProjectId?: string) => {
    const [projectResult, memberResult] = await Promise.all([
      api.get<{ projects: Project[] }>("/api/projects"),
      api.get<{ members: TeamMember[] }>("/api/team"),
    ]);
    setProjects(projectResult.projects);
    setTeamMembers(memberResult.members);
    const remembered = preferredProjectId ?? localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "";
    const selected = projectResult.projects.find((project) => project.id === remembered) ?? projectResult.projects[0];
    if (selected !== undefined) await loadProject(selected.id);
    else setActiveProject(undefined);
  }, [loadProject]);

  useEffect(() => {
    const initialize = async () => {
      try {
        const current = await api.get<AuthState>("/api/auth/me");
        setAuth(current);
        if (current.teamMember) await loadWorkspace();
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 401)) setError(errorMessage(caught));
      } finally {
        setLoadingAuth(false);
      }
    };
    void initialize();
  }, [loadWorkspace]);

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  useEffect(() => {
    if (collaboration.invalidationVersion === 0 || !activeProject) return;
    void loadWorkspace(activeProject.project.id).catch((caught) => {
      setError(errorMessage(caught));
    });
  }, [collaboration.invalidationVersion, activeProject?.project.id, loadWorkspace]);

  const authenticated = async (nextAuth: AuthState) => {
    setAuth(nextAuth);
    if (nextAuth.teamMember) await loadWorkspace();
  };

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      setAuth(undefined);
      setProjects([]);
      setActiveProject(undefined);
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
    }
  };

  const redeemed = async (projectId: string) => {
    if (!auth) return;
    setAuth({ ...auth, teamMember: true });
    await loadWorkspace(projectId);
  };

  const projectCreated = (detail: ProjectDetail) => {
    tour.completeSection("project-setup");
    setProjects((current) => [...current, detail.project]);
    setActiveProject(detail);
    localStorage.setItem(ACTIVE_PROJECT_KEY, detail.project.id);
    setShowCreateProject(false);
  };

  const replayGuide = (section: TourSection) => {
    setShowProjectSettings(false);
    const entryView = tourDefinition(section).entryView;
    if (entryView) setActiveView(entryView);
    tour.start(section, true);
  };

  const openGuidedProjectDialog = () => {
    tour.pauseForAction();
    setShowCreateProject(true);
  };

  if (loadingAuth) {
    return <main className="loading-page"><LoaderCircle className="spin" size={28} /><span>正在连接团队工作区</span></main>;
  }
  if (!auth) return <AuthScreen onAuthenticated={(next) => void authenticated(next)} />;
  if (!auth.teamMember) return <RedeemInviteScreen displayName={auth.user.displayName} onRedeemed={(id) => void redeemed(id)} onLogout={() => void logout()} />;
  if (!activeProject) {
    return (
      <>
      <main className="empty-workspace">
        <BrandMark />
        <section>
          <h1>创建第一个项目</h1>
          <p>为本次比赛或科研课题选择固定成员，再建立阶段与任务排期。</p>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-button" type="button" data-tour-id="empty-create-project" onClick={() => setShowCreateProject(true)}><Plus size={16} />新建项目</button>
          <button className="secondary-button" type="button" onClick={() => setShowProjectSettings(true)}><Archive size={16} />项目归档与回收站</button>
        </section>
        {showTutorial ? <DemoTutorial onClose={finishTutorial} /> : null}
        {showCreateProject ? <CreateProjectDialog teamMembers={teamMembers} onClose={() => setShowCreateProject(false)} onCreated={projectCreated} /> : null}
        {showProjectSettings ? <ProjectSettingsDialog teamMembers={teamMembers} online={online} guideProgress={tour.progress} onClose={() => setShowProjectSettings(false)} onChanged={loadWorkspace} onReplayGuide={replayGuide} onResetGuides={tour.resetAll} /> : null}
      </main>
      {!showTutorial && tutorialDone ? (
        <ProductTour controller={tour} onCreateProject={openGuidedProjectDialog} />
      ) : null}
      </>
    );
  }

  return (
    <>
      <AppShell
        auth={auth}
        projects={projects}
        activeProject={activeProject}
        activeView={activeView}
        online={online}
        realtimeConnected={collaboration.connected}
        onlineUsers={collaboration.users}
        appearance={appearance}
        forceSidebarExpanded={tour.active?.section === "workspace" && tour.viewportSupported}
        onChangeProject={(id) => void loadProject(id).catch((caught) => setError(errorMessage(caught)))}
        onChangeView={setActiveView}
        onCreateProject={() => setShowCreateProject(true)}
        onInvite={() => setShowInvite(true)}
        onRegistrationInvites={() => setShowRegistrationInvites(true)}
        onOpenHelp={() => setShowHelp(true)}
        onOpenTutorial={() => setShowTutorial(true)}
        onProjectSettings={() => setShowProjectSettings(true)}
        onLogout={() => void logout()}
      >
        <Suspense fallback={<div className="view-placeholder"><LoaderCircle className="spin" size={22} /><span>正在载入工作区</span></div>}>
          {activeView === "meeting" ? (
            <MeetingView
              project={activeProject}
              currentUserId={auth.user.id}
              collaboration={collaboration}
              online={online}
              onJumpToGantt={() => setActiveView("gantt")}
            />
          ) : activeView === "gantt" ? (
            <GanttView
              project={activeProject}
              currentUserId={auth.user.id}
              online={online}
              collaboration={collaboration}
            />
          ) : activeView === "resources" ? (
            <ResourceLibrary
              projectId={activeProject.project.id}
              online={online}
              invalidationVersion={collaboration.invalidationVersion}
            />
          ) : (
            <AvailabilityView
              projectId={activeProject.project.id}
              currentUserId={auth.user.id}
              online={online}
              invalidationVersion={collaboration.invalidationVersion}
            />
          )}
        </Suspense>
      </AppShell>
      {showHelp ? <HelpDialog onClose={() => setShowHelp(false)} /> : null}
      {showTutorial ? <DemoTutorial onClose={finishTutorial} /> : null}
      {showCreateProject ? <CreateProjectDialog teamMembers={teamMembers} onClose={() => setShowCreateProject(false)} onCreated={projectCreated} /> : null}
      {showInvite ? <InviteDialog projectId={activeProject.project.id} projectName={activeProject.project.name} onClose={() => setShowInvite(false)} /> : null}
      <RegistrationInvitesDialog
        open={showRegistrationInvites}
        onClose={() => setShowRegistrationInvites(false)}
      />
      {showProjectSettings ? <ProjectSettingsDialog project={activeProject} teamMembers={teamMembers} online={online} guideProgress={tour.progress} onClose={() => setShowProjectSettings(false)} onChanged={() => loadWorkspace(activeProject.project.id)} onReplayGuide={replayGuide} onResetGuides={tour.resetAll} /> : null}
      {!showTutorial && tutorialDone ? (
        <ProductTour controller={tour} onCreateProject={openGuidedProjectDialog} />
      ) : null}
    </>
  );
}
