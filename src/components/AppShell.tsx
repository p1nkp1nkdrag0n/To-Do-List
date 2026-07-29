import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  FileArchive,
  GanttChartSquare,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
  SunMoon,
  UserPlus,
} from "lucide-react";

import type { PresenceUser } from "../../shared/realtime-contracts";
import type { AppearanceController } from "../lib/useAppearance";
import type { AuthState, Project, ProjectDetail } from "../types";
import { BrandMark } from "./BrandMark";

export type WorkspaceView = "gantt" | "resources" | "availability";

interface AppShellProps {
  auth: AuthState;
  projects: Project[];
  activeProject: ProjectDetail;
  activeView: WorkspaceView;
  online: boolean;
  realtimeConnected: boolean;
  onlineUsers: PresenceUser[];
  appearance: AppearanceController;
  forceSidebarExpanded?: boolean;
  children: ReactNode;
  onChangeProject: (projectId: string) => void;
  onChangeView: (view: WorkspaceView) => void;
  onCreateProject: () => void;
  onInvite: () => void;
  onProjectSettings: () => void;
  onLogout: () => void;
}

const navigation: Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof GanttChartSquare;
}> = [
  { id: "gantt", label: "甘特图", icon: GanttChartSquare },
  { id: "resources", label: "资料库", icon: FileArchive },
  { id: "availability", label: "可用时间", icon: CalendarClock },
];

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase();
}

export function AppShell({
  auth,
  projects,
  activeProject,
  activeView,
  online,
  realtimeConnected,
  onlineUsers,
  appearance,
  forceSidebarExpanded = false,
  children,
  onChangeProject,
  onChangeView,
  onCreateProject,
  onInvite,
  onProjectSettings,
  onLogout,
}: AppShellProps) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [appearanceMenuOpen, setAppearanceMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const appearanceMenuRef = useRef<HTMLSpanElement>(null);
  const onlineUserIds = new Set(onlineUsers.map((user) => user.userId));
  const effectiveSidebarPreference = forceSidebarExpanded
    ? "expanded"
    : appearance.sidebarPreference;
  const sidebarCollapsed = effectiveSidebarPreference === "collapsed";
  const connectionLabel = !online
    ? "离线，只读"
    : realtimeConnected
      ? `${onlineUsers.length} 人在线`
      : "实时重连中";

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!projectMenuRef.current?.contains(target)) setProjectMenuOpen(false);
      if (!appearanceMenuRef.current?.contains(target)) setAppearanceMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectMenuOpen(false);
        setAppearanceMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <>
      <div className={`app-shell sidebar-${effectiveSidebarPreference}`}>
        <aside className="sidebar glass-panel">
          <div className="brand-row">
            <BrandMark compact={sidebarCollapsed} />
            <button
              className="icon-button sidebar-collapse"
              type="button"
              aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              data-tooltip={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              onClick={appearance.toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>

          <div className="sidebar-project" ref={projectMenuRef}>
            <span className="sidebar-section-label">当前项目</span>
            <div className="project-switcher-wrap" data-tour-id="project-switcher">
              <button
                className="project-switcher"
                type="button"
                aria-expanded={projectMenuOpen}
                aria-haspopup="menu"
                onClick={() => setProjectMenuOpen((current) => !current)}
              >
                <span>{activeProject.project.name}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {projectMenuOpen ? (
                <div className="floating-menu project-menu" role="menu" aria-label="切换项目">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className={project.id === activeProject.project.id ? "selected" : ""}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onChangeProject(project.id);
                        setProjectMenuOpen(false);
                      }}
                    >
                      <span>{project.name}</span>
                      {project.id === activeProject.project.id ? <Check size={15} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="sidebar-add" type="button" onClick={onCreateProject}>
              <Plus size={15} /> 新建项目
            </button>
          </div>

          <nav className="main-nav" aria-label="工作区导航" data-tour-id="workspace-navigation">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={activeView === item.id ? "active" : ""}
                  type="button"
                  aria-label={item.label}
                  aria-current={activeView === item.id ? "page" : undefined}
                  title={sidebarCollapsed ? item.label : undefined}
                  data-tooltip={item.label}
                  onClick={() => onChangeView(item.id)}
                >
                  <Icon size={19} />
                  <span className="nav-label">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <button
              type="button"
              aria-label="邀请项目成员"
              title={sidebarCollapsed ? "邀请项目成员" : undefined}
              data-tooltip="邀请项目成员"
              onClick={onInvite}
            >
              <UserPlus size={17} />
              <span className="utility-label">邀请项目成员</span>
            </button>
            <button
              type="button"
              aria-label="项目设置"
              title={sidebarCollapsed ? "项目设置" : undefined}
              data-tooltip="项目设置"
              onClick={onProjectSettings}
            >
              <Settings size={17} />
              <span className="utility-label">项目设置</span>
            </button>
            <div className="profile-row">
              <span className="avatar avatar-self">{initials(auth.user.displayName)}</span>
              <span className="profile-copy">
                <strong>{auth.user.displayName}</strong>
                <small>
                  <i className={online && realtimeConnected ? "online-dot" : "offline-dot"} />
                  {!online ? "离线" : realtimeConnected ? "在线" : "重连中"}
                </small>
              </span>
              <span className="profile-actions">
                <span className="appearance-control" ref={appearanceMenuRef}>
                  <button
                    className="icon-button"
                    type="button"
                    aria-expanded={appearanceMenuOpen}
                    aria-haspopup="menu"
                    aria-label="外观"
                    title="外观"
                    data-tooltip="外观"
                    onClick={() => setAppearanceMenuOpen((current) => !current)}
                  >
                    <SunMoon size={16} />
                  </button>
                  {appearanceMenuOpen ? (
                    <span className="floating-menu appearance-menu" role="menu" aria-label="主题">
                      {([
                        ["system", "跟随系统", Monitor],
                        ["light", "浅色", Sun],
                        ["dark", "深色", Moon],
                      ] as const).map(([value, label, Icon]) => (
                        <button
                          key={value}
                          className={appearance.themePreference === value ? "selected" : ""}
                          type="button"
                          role="menuitemradio"
                          aria-checked={appearance.themePreference === value}
                          onClick={() => {
                            appearance.setThemePreference(value);
                            setAppearanceMenuOpen(false);
                          }}
                        >
                          <Icon size={15} />
                          <span>{label}</span>
                          {appearance.themePreference === value ? <Check size={14} /> : null}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </span>
                <button
                  className="icon-button"
                  type="button"
                  onClick={onLogout}
                  aria-label="退出登录"
                  title="退出登录"
                  data-tooltip="退出登录"
                >
                  <LogOut size={16} />
                </button>
              </span>
            </div>
          </div>
        </aside>

        <main className="workspace">
          <header className="topbar glass-panel">
            <div className="topbar-project">
              <strong>{activeProject.project.name}</strong>
              <span>{activeProject.members.length} 名成员</span>
            </div>
            <div className="topbar-actions">
              <div className="avatar-stack" aria-label="项目成员">
                {activeProject.members.slice(0, 5).map((member) => (
                  <span
                    className={`avatar ${onlineUserIds.has(member.userId) ? "presence-online" : "presence-offline"}`}
                    key={member.userId}
                    style={{ backgroundColor: member.color }}
                    title={`${member.displayName} · ${onlineUserIds.has(member.userId) ? "在线" : "离线"}`}
                  >
                    {initials(member.displayName)}
                  </span>
                ))}
                {activeProject.members.length > 5 ? (
                  <span className="avatar avatar-more">+{activeProject.members.length - 5}</span>
                ) : null}
              </div>
              <span className="presence">
                <i className={online && realtimeConnected ? "online-dot" : "offline-dot"} />
                {connectionLabel}
              </span>
              <button className="secondary-button topbar-invite" type="button" onClick={onInvite} data-tour-id="project-invite">
                <UserPlus size={16} /> 邀请
              </button>
            </div>
          </header>
          <div className="workspace-content">{children}</div>
        </main>
      </div>

      <main className="desktop-required">
        <BrandMark />
        <h1>请使用桌面端工作区</h1>
        <p>当前排期工具需要至少 1100px 的可用宽度。</p>
      </main>
    </>
  );
}
