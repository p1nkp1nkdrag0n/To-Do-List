import type { ReactNode } from "react";
import {
  CalendarClock,
  ChevronDown,
  FileArchive,
  FolderKanban,
  GanttChartSquare,
  LogOut,
  Plus,
  Settings,
  UserPlus,
} from "lucide-react";

import type { AuthState, Project, ProjectDetail } from "../types";
import type { PresenceUser } from "../../shared/realtime-contracts";

export type WorkspaceView = "gantt" | "resources" | "availability";

interface AppShellProps {
  auth: AuthState;
  projects: Project[];
  activeProject: ProjectDetail;
  activeView: WorkspaceView;
  online: boolean;
  realtimeConnected: boolean;
  onlineUsers: PresenceUser[];
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
  children,
  onChangeProject,
  onChangeView,
  onCreateProject,
  onInvite,
  onProjectSettings,
  onLogout,
}: AppShellProps) {
  const onlineUserIds = new Set(onlineUsers.map((user) => user.userId));
  const connectionLabel = !online
    ? "离线，只读"
    : realtimeConnected
      ? `${onlineUsers.length} 人在线`
      : "实时重连中";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <span className="brand-mark">研程</span>
          <FolderKanban size={19} aria-hidden="true" />
        </div>
        <div className="sidebar-project">
          <label htmlFor="project-switcher">当前项目</label>
          <div className="project-select-wrap">
            <select
              id="project-switcher"
              value={activeProject.project.id}
              onChange={(event) => onChangeProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </div>
          <button className="sidebar-add" type="button" onClick={onCreateProject}>
            <Plus size={15} /> 新建项目
          </button>
        </div>
        <nav className="main-nav" aria-label="工作区导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={activeView === item.id ? "active" : ""}
                type="button"
                onClick={() => onChangeView(item.id)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button type="button" onClick={onInvite}>
            <UserPlus size={17} /> 邀请项目成员
          </button>
          <button type="button" onClick={onProjectSettings} aria-label="项目设置">
            <Settings size={17} /> 项目设置
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
            <button className="icon-button" type="button" onClick={onLogout} title="退出登录">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-project">
            <strong>{activeProject.project.name}</strong>
            <span>{activeProject.members.length} 名成员</span>
          </div>
          <div className="topbar-actions">
            <span className="presence">
              <i className={online && realtimeConnected ? "online-dot" : "offline-dot"} />
              {connectionLabel}
            </span>
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
              {activeProject.members.length > 5 ? <span className="avatar avatar-more">+{activeProject.members.length - 5}</span> : null}
            </div>
            <button className="secondary-button" type="button" onClick={onInvite}>
              <UserPlus size={16} /> 邀请
            </button>
          </div>
        </header>
        <div className="workspace-content">{children}</div>
      </main>
    </div>
  );
}
