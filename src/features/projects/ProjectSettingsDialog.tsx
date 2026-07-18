import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  UserMinus,
} from "lucide-react";

import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import type {
  ProjectDetail,
  ProjectLifecycleItem,
  Schedule,
  TaskLifecycleItem,
  TeamMember,
} from "../../types";

type SettingsTab = "current" | "tasks" | "projects";

interface ProjectSettingsDialogProps {
  project?: ProjectDetail;
  teamMembers: TeamMember[];
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export function ProjectSettingsDialog({ project, teamMembers, online, onClose, onChanged }: ProjectSettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(project ? "current" : "projects");
  const [scheduleRevision, setScheduleRevision] = useState<number>();
  const [archivedTasks, setArchivedTasks] = useState<TaskLifecycleItem[]>([]);
  const [trashTasks, setTrashTasks] = useState<TaskLifecycleItem[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectLifecycleItem[]>([]);
  const [trashProjects, setTrashProjects] = useState<ProjectLifecycleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [archivedProjectResult, trashProjectResult, scheduleResult, archivedTaskResult, trashTaskResult] = await Promise.all([
        api.get<{ projects: ProjectLifecycleItem[] }>("/api/projects/archived"),
        api.get<{ projects: ProjectLifecycleItem[] }>("/api/trash/projects"),
        project ? api.get<Schedule>(`/api/projects/${project.project.id}/schedule`) : Promise.resolve(undefined),
        project ? api.get<{ tasks: TaskLifecycleItem[] }>(`/api/projects/${project.project.id}/archived/tasks`) : Promise.resolve({ tasks: [] }),
        project ? api.get<{ tasks: TaskLifecycleItem[] }>(`/api/projects/${project.project.id}/trash`) : Promise.resolve({ tasks: [] }),
      ]);
      setArchivedProjects(archivedProjectResult.projects);
      setTrashProjects(trashProjectResult.projects);
      setScheduleRevision(scheduleResult?.revision);
      setArchivedTasks(archivedTaskResult.tasks);
      setTrashTasks(trashTaskResult.tasks);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [project?.project.id]);

  useEffect(() => { void load(); }, [load]);

  const run = async (operation: () => Promise<void>, refreshWorkspace = false) => {
    if (!online) { setError("当前离线，不能修改项目设置。"); return false; }
    setBusy(true); setError("");
    try {
      await operation();
      if (refreshWorkspace) await onChanged();
      await load();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="项目设置" width="large" onClose={onClose}>
      <div className="project-settings">
        <nav className="dialog-tabs" aria-label="项目设置分类">
          {project ? <button type="button" className={tab === "current" ? "active" : ""} onClick={() => setTab("current")}>当前项目</button> : null}
          {project ? <button type="button" className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>任务归档与回收站</button> : null}
          <button type="button" className={tab === "projects" ? "active" : ""} onClick={() => setTab("projects")}>项目归档与回收站</button>
        </nav>
        {error ? <p className="form-error settings-message">{error}</p> : null}
        {loading ? <div className="table-loading"><LoaderCircle className="spin" size={20} />正在读取项目设置</div> : tab === "current" && project ? (
          <CurrentProjectSettings project={project} teamMembers={teamMembers} scheduleRevision={scheduleRevision} online={online} busy={busy} run={run} onChanged={onChanged} onClose={onClose} />
        ) : tab === "tasks" && project ? (
          <TaskLifecycleSettings projectId={project.project.id} scheduleRevision={scheduleRevision} archived={archivedTasks} trash={trashTasks} online={online} busy={busy} run={run} />
        ) : (
          <ProjectLifecycleSettings archived={archivedProjects} trash={trashProjects} online={online} busy={busy} run={run} />
        )}
      </div>
    </Modal>
  );
}

function CurrentProjectSettings({ project, teamMembers, scheduleRevision, online, busy, run, onChanged, onClose }: {
  project: ProjectDetail;
  teamMembers: TeamMember[];
  scheduleRevision?: number;
  online: boolean;
  busy: boolean;
  run: (operation: () => Promise<void>, refreshWorkspace?: boolean) => Promise<boolean>;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.project.name);
  const [description, setDescription] = useState(project.project.description);
  const [startDate, setStartDate] = useState(project.project.startDate ?? "");
  const [endDate, setEndDate] = useState(project.project.endDate ?? "");
  const candidates = useMemo(() => teamMembers.filter((member) => !project.members.some((projectMember) => projectMember.userId === member.userId)), [project.members, teamMembers]);
  const [newMemberId, setNewMemberId] = useState("");

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.patch(`/api/projects/${project.project.id}`, {
        expectedRevision: project.project.revision,
        name,
        description,
        startDate: startDate || null,
        endDate: endDate || null,
      });
    }, true);
  };
  const addMember = () => {
    if (!newMemberId) return;
    void run(async () => {
      await api.post(`/api/projects/${project.project.id}/members`, { userId: newMemberId });
      setNewMemberId("");
    }, true);
  };
  const removeMember = (userId: string, displayName: string, revision: number) => {
    if (!window.confirm(`将 ${displayName} 移出当前项目？`)) return;
    void run(() => api.delete(`/api/projects/${project.project.id}/members/${userId}`, { expectedRevision: revision }), true);
  };
  const archive = () => {
    if (!window.confirm(`归档项目“${project.project.name}”？归档后项目只读。`)) return;
    void run(() => api.post(`/api/projects/${project.project.id}/archive`, { expectedRevision: project.project.revision }), true).then((succeeded) => { if (succeeded) onClose(); });
  };
  const trash = () => {
    if (scheduleRevision === undefined || !window.confirm(`将项目“${project.project.name}”及其任务和资料移入 30 天回收站？`)) return;
    void run(() => api.delete(`/api/projects/${project.project.id}`, { expectedRevision: project.project.revision, expectedScheduleRevision: scheduleRevision }), true).then((succeeded) => { if (succeeded) onClose(); });
  };

  return <div className="project-settings-body"><form className="drawer-form project-form" onSubmit={save}><h3>项目信息</h3><label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>项目说明<textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label><div className="form-grid two-columns"><label>项目开始<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>项目结束<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div><button className="primary-button settings-save" type="submit" disabled={!online || busy}><Save size={15} />保存项目信息</button></form><section className="settings-section"><header><div><h3>项目成员</h3><p>项目成员完全平权，任何成员都可维护项目结构。</p></div><span>{project.members.length} 人</span></header><div className="project-member-list">{project.members.map((member) => <article key={member.userId}><span className="avatar" style={{ backgroundColor: member.color }}>{member.displayName.slice(0, 1)}</span><div><strong>{member.displayName}</strong><small>@{member.username}</small></div><button className="icon-button" type="button" title="移出项目" aria-label={`移出 ${member.displayName}`} onClick={() => removeMember(member.userId, member.displayName, member.revision)} disabled={!online || busy || project.members.length === 1}><UserMinus size={15} /></button></article>)}</div>{candidates.length ? <div className="inline-add"><select aria-label="添加团队成员" value={newMemberId} onChange={(event) => setNewMemberId(event.target.value)}><option value="">选择团队成员</option>{candidates.map((member) => <option key={member.userId} value={member.userId}>{member.displayName} · @{member.username}</option>)}</select><button className="secondary-button" type="button" onClick={addMember} disabled={!online || busy || !newMemberId}><Plus size={15} />加入项目</button></div> : null}</section><section className="danger-zone"><header><div><h3>项目生命周期</h3><p>归档适合阶段性结束；回收站保留 30 天恢复窗口。</p></div></header><button className="secondary-button" type="button" onClick={archive} disabled={!online || busy}><Archive size={15} />归档当前项目</button><button className="danger-button" type="button" onClick={trash} disabled={!online || busy || scheduleRevision === undefined}><Trash2 size={15} />移入项目回收站</button></section></div>;
}

function TaskLifecycleSettings({ projectId, scheduleRevision, archived, trash, online, busy, run }: { projectId: string; scheduleRevision?: number; archived: TaskLifecycleItem[]; trash: TaskLifecycleItem[]; online: boolean; busy: boolean; run: (operation: () => Promise<void>) => Promise<boolean> }) {
  const act = (path: string, task: TaskLifecycleItem, permanent = false) => {
    if (scheduleRevision === undefined) return;
    if (permanent && !window.confirm(`永久删除“${task.title}”及其子任务？此操作无法恢复。`)) return;
    const body = { expectedRevision: task.revision, expectedScheduleRevision: scheduleRevision, ...(permanent ? { confirmation: task.id } : {}) };
    void run(() => permanent ? api.delete(`/api/projects/${projectId}/tasks/${task.id}/permanent`, body) : api.post(`/api/projects/${projectId}/tasks/${task.id}/${path}`, body));
  };
  return <div className="project-settings-body lifecycle-columns"><LifecycleTaskList title="已归档任务" empty="暂无已归档任务" items={archived} actions={(task) => <button className="secondary-button" type="button" onClick={() => act("unarchive", task)} disabled={!online || busy}><ArchiveRestore size={14} />取消归档</button>} /><LifecycleTaskList title="任务回收站" empty="任务回收站为空" items={trash} actions={(task) => <><button className="secondary-button" type="button" onClick={() => act("restore", task)} disabled={!online || busy}><ArchiveRestore size={14} />恢复</button><button className="danger-text-button" type="button" onClick={() => act("", task, true)} disabled={!online || busy}><Trash2 size={14} />永久删除</button></>} /></div>;
}

function LifecycleTaskList({ title, empty, items, actions }: { title: string; empty: string; items: TaskLifecycleItem[]; actions: (item: TaskLifecycleItem) => React.ReactNode }) {
  return <section className="settings-section lifecycle-list"><header><h3>{title}</h3><span>{items.length} 项</span></header>{items.length === 0 ? <p className="compact-empty">{empty}</p> : items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.deletedAt ? `删除于 ${new Date(item.deletedAt).toLocaleString("zh-CN")}` : `归档于 ${new Date(item.archivedAt!).toLocaleString("zh-CN")}`}{item.purgeAfter ? ` · ${new Date(item.purgeAfter).toLocaleDateString("zh-CN")} 后可清理` : ""}</small></div><span>{actions(item)}</span></article>)}</section>;
}

function ProjectLifecycleSettings({ archived, trash, online, busy, run }: { archived: ProjectLifecycleItem[]; trash: ProjectLifecycleItem[]; online: boolean; busy: boolean; run: (operation: () => Promise<void>, refreshWorkspace?: boolean) => Promise<boolean> }) {
  const [permanentTarget, setPermanentTarget] = useState<ProjectLifecycleItem>();
  const [confirmation, setConfirmation] = useState("");
  const unarchive = (project: ProjectLifecycleItem) => void run(() => api.post(`/api/projects/${project.id}/unarchive`, { expectedRevision: project.revision }), true);
  const restore = (project: ProjectLifecycleItem) => void run(() => api.post(`/api/trash/projects/${project.id}/restore`, { expectedRevision: project.revision }), true);
  const permanentlyDelete = () => {
    if (!permanentTarget || confirmation !== permanentTarget.name) return;
    void run(() => api.delete(`/api/trash/projects/${permanentTarget.id}/permanent`, { expectedRevision: permanentTarget.revision, confirmation: permanentTarget.id }), true).then((succeeded) => { if (succeeded) { setPermanentTarget(undefined); setConfirmation(""); } });
  };
  return <div className="project-settings-body lifecycle-columns"><section className="settings-section lifecycle-list"><header><h3>已归档项目</h3><span>{archived.length} 项</span></header>{archived.length === 0 ? <p className="compact-empty">暂无已归档项目</p> : archived.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.description || "无项目说明"}</small></div><span><button className="secondary-button" type="button" onClick={() => unarchive(item)} disabled={!online || busy}><ArchiveRestore size={14} />取消归档</button></span></article>)}</section><section className="settings-section lifecycle-list"><header><h3>项目回收站</h3><span>{trash.length} 项</span></header>{trash.length === 0 ? <p className="compact-empty">项目回收站为空</p> : trash.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.purgeAfter ? `恢复窗口至 ${new Date(item.purgeAfter).toLocaleString("zh-CN")}` : ""}</small></div><span><button className="secondary-button" type="button" onClick={() => restore(item)} disabled={!online || busy}><ArchiveRestore size={14} />恢复</button><button className="danger-text-button" type="button" onClick={() => { setPermanentTarget(item); setConfirmation(""); }} disabled={!online || busy}><Trash2 size={14} />永久删除</button></span></article>)}</section>{permanentTarget ? <section className="permanent-confirm"><h3>永久删除“{permanentTarget.name}”</h3><p>将删除项目数据库记录和资料文件。输入完整项目名称进行第二次确认。</p><label>项目名称<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus /></label><div><button className="secondary-button" type="button" onClick={() => setPermanentTarget(undefined)}>取消</button><button className="danger-button" type="button" onClick={permanentlyDelete} disabled={confirmation !== permanentTarget.name || busy}>确认永久删除</button></div></section> : null}</div>;
}
