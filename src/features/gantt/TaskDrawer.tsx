import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  Link2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  UserRoundPlus,
  X,
} from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import { todayIso } from "../../lib/date";
import { useSessionDraft } from "../../lib/useSessionDraft";
import type {
  Deliverable,
  Participant,
  ProgressEntry,
  ProjectDetail,
  ResourceEntity,
  Schedule,
  Task,
} from "../../types";

type DrawerTab = "basic" | "assignments" | "progress" | "dependencies" | "deliverables";

interface TaskDrawerProps {
  project: ProjectDetail;
  schedule: Schedule;
  task: Task | null;
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const tabItems: Array<{ id: DrawerTab; label: string }> = [
  { id: "basic", label: "基本信息" },
  { id: "assignments", label: "责任分工" },
  { id: "progress", label: "进展记录" },
  { id: "dependencies", label: "依赖" },
  { id: "deliverables", label: "交付物" },
];

const statusNames = {
  not_started: "未开始",
  in_progress: "进行中",
  blocked: "受阻",
  pending_review: "待验收",
  done: "已完成",
} as const;

function initialTaskForm(task: Task | null) {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    phaseId: task?.phaseId ?? "",
    parentId: task?.parentId ?? "",
    startDate: task?.startDate ?? "",
    dueDate: task?.dueDate ?? "",
  };
}

export function TaskDrawer({ project, schedule, task, online, onClose, onChanged }: TaskDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>("basic");
  const [form, setForm, clearForm] = useSessionDraft(
    `yancheng.taskDraft.${project.project.id}.${task?.id ?? "new"}`,
    initialTaskForm(task),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTab("basic");
    setError("");
  }, [task?.id]);

  const assignments = useMemo(
    () => task ? schedule.participants.filter((participant) => participant.taskId === task.id) : [],
    [schedule.participants, task],
  );

  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (!online) {
      setError("当前处于离线状态，草稿已保留，恢复连接后再提交。");
      return false;
    }
    setBusy(true);
    setError("");
    try {
      await operation();
      clearForm();
      await onChanged();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveBasic = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const payload = {
        title: form.title,
        description: form.description,
        phaseId: form.phaseId || null,
        parentId: form.parentId || null,
        startDate: form.startDate || null,
        dueDate: form.dueDate || null,
      };
      if (task === null) {
        await api.post(`/api/projects/${project.project.id}/tasks`, payload);
      } else {
        await api.patch(`/api/projects/${project.project.id}/tasks/${task.id}`, {
          expectedRevision: task.revision,
          ...payload,
        });
      }
    });
  };

  const reviewOrReopen = () => {
    if (!task) return;
    const action = task.status === "done" ? "reopen" : "review";
    void run(() =>
      api.post(`/api/projects/${project.project.id}/tasks/${task.id}/${action}`, {
        expectedRevision: task.revision,
      }),
    );
  };

  const archiveTask = () => {
    if (!task) return;
    void run(() =>
      api.post(`/api/projects/${project.project.id}/tasks/${task.id}/archive`, {
        expectedRevision: task.revision,
        expectedScheduleRevision: schedule.revision,
      }),
    ).then((succeeded) => {
      if (succeeded) onClose();
    });
  };

  const trashTask = () => {
    if (!task || !window.confirm(`将“${task.title}”及其子任务移入回收站？`)) return;
    void run(() =>
      api.delete(`/api/projects/${project.project.id}/tasks/${task.id}`, {
        expectedRevision: task.revision,
        expectedScheduleRevision: schedule.revision,
      }),
    ).then((succeeded) => {
      if (succeeded) onClose();
    });
  };

  const locked = task?.status === "done";
  return (
    <aside className="detail-drawer" aria-label={task ? `任务详情：${task.title}` : "新建任务"}>
      <header className="drawer-header">
        <div>
          <small>{task ? "任务详情" : "新建任务"}</small>
          <h2>{task?.title || "创建排期任务"}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情" title="关闭"><X size={19} /></button>
      </header>
      {task ? (
        <div className="drawer-status-row">
          <span className={`status-badge status-${task.status}`}>{statusNames[task.status]}</span>
          <span>修订 {task.revision}</span>
          {schedule.conflicts.some((conflict) => "taskId" in conflict && conflict.taskId === task.id) ? <strong className="danger-text"><CircleAlert size={15} />存在排期冲突</strong> : null}
        </div>
      ) : null}
      <nav className="drawer-tabs">
        {tabItems.map((item) => (
          <button key={item.id} type="button" disabled={task === null && item.id !== "basic"} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </nav>
      <div className="drawer-body">
        {tab === "basic" ? (
          <form className="drawer-form" onSubmit={saveBasic}>
            {locked ? <div className="locked-notice"><CheckCircle2 size={17} />任务已完成，重新打开后才能修改。</div> : null}
            <label>任务名称<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} disabled={locked} /></label>
            <div className="form-grid two-columns">
              <label>所属阶段<select value={form.phaseId} onChange={(event) => setForm({ ...form, phaseId: event.target.value })} disabled={locked}><option value="">未分阶段</option>{schedule.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label>
              <label>父任务<select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })} disabled={locked}><option value="">无</option>{schedule.tasks.filter((candidate) => candidate.id !== task?.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
              <label>开始日期<input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} disabled={locked} /></label>
              <label>截止日期<input type="date" min={form.startDate || undefined} value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} disabled={locked} /></label>
            </div>
            <label>任务说明<textarea rows={6} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={10000} disabled={locked} /></label>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="drawer-primary-actions">
              {task?.status === "pending_review" || task?.status === "done" ? (
                <button className="secondary-button" type="button" disabled={!online || busy} onClick={reviewOrReopen}>{task.status === "done" ? <RotateCcw size={16} /> : <CheckCircle2 size={16} />}{task.status === "done" ? "重新打开" : "验收完成"}</button>
              ) : null}
              <button className="primary-button" type="submit" disabled={!online || busy || locked}><Save size={16} />{busy ? "保存中…" : task ? "保存任务" : "创建任务"}</button>
            </div>
            {task ? <div className="drawer-danger-actions"><button type="button" onClick={archiveTask} disabled={!online || busy || task.status === "done"} title={task.status === "done" ? "先重新打开任务再归档" : undefined}><Archive size={15} />归档</button><button type="button" onClick={trashTask} disabled={!online || busy || task.status === "done"}><Trash2 size={15} />移入回收站</button></div> : null}
          </form>
        ) : null}
        {tab === "assignments" && task ? <AssignmentsPanel projectId={project.project.id} task={task} members={project.members} assignments={assignments} online={online} onChanged={onChanged} /> : null}
        {tab === "progress" && task ? <ProgressPanel projectId={project.project.id} assignments={assignments} online={online} onChanged={onChanged} /> : null}
        {tab === "dependencies" && task ? <DependenciesPanel projectId={project.project.id} task={task} schedule={schedule} online={online} onChanged={onChanged} /> : null}
        {tab === "deliverables" && task ? <DeliverablesPanel projectId={project.project.id} task={task} schedule={schedule} online={online} onChanged={onChanged} /> : null}
      </div>
    </aside>
  );
}

function AssignmentsPanel({ projectId, task, members, assignments, online, onChanged }: {
  projectId: string;
  task: Task;
  members: ProjectDetail["members"];
  assignments: Participant[];
  online: boolean;
  onChanged: () => Promise<void>;
}) {
  const availableMembers = members.filter((member) => !assignments.some((item) => item.userId === member.userId));
  const [userId, setUserId] = useState(availableMembers[0]?.userId ?? "");
  const [startDate, setStartDate] = useState(task.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(task.dueDate ?? task.startDate ?? todayIso());
  const [hours, setHours] = useState("8");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api.post(`/api/projects/${projectId}/tasks/${task.id}/participants`, {
        userId,
        startDate,
        endDate,
        estimatedMinutes: Math.round(Number(hours) * 60),
      });
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const remove = async (participant: Participant) => {
    if (!window.confirm(`移除 ${participant.displayName} 的任务分工？`)) return;
    try {
      await api.delete(`/api/projects/${projectId}/participants/${participant.id}`, { expectedRevision: participant.revision });
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <section className="drawer-section">
      <div className="section-heading"><div><h3>成员分工</h3><p>同一成员在任务中仅保留一条分工。</p></div><span>{assignments.length} 人</span></div>
      <div className="assignment-list">
        {assignments.map((participant) => (
          <article key={participant.id}>
            <span className="avatar" style={{ backgroundColor: participant.color }}>{participant.displayName.slice(0, 1)}</span>
            <div><strong>{participant.displayName}</strong><small>{participant.startDate} 至 {participant.endDate}</small><div className="mini-progress"><i style={{ width: `${participant.progressPercent}%` }} /></div></div>
            <span><strong>{(participant.estimatedMinutes / 60).toFixed(1)}h</strong><small>{participant.progressPercent}%</small></span>
            <button className="icon-button" type="button" onClick={() => void remove(participant)} disabled={!online || task.status === "done"} title="移除分工" aria-label={`移除 ${participant.displayName} 的分工`}><Trash2 size={15} /></button>
          </article>
        ))}
      </div>
      {availableMembers.length ? (
        <form className="subform" onSubmit={submit}>
          <h4><UserRoundPlus size={16} />添加成员分工</h4>
          <label>负责人<select value={userId} onChange={(event) => setUserId(event.target.value)}>{availableMembers.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></label>
          <div className="form-grid two-columns"><label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
          <label>预计工时（小时）<input type="number" min="0.5" step="0.5" value={hours} onChange={(event) => setHours(event.target.value)} /></label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={!online || !userId || task.status === "done"}><Plus size={15} />添加分工</button>
        </form>
      ) : null}
    </section>
  );
}

function ProgressPanel({ projectId, assignments, online, onChanged }: { projectId: string; assignments: Participant[]; online: boolean; onChanged: () => Promise<void> }) {
  const [participantId, setParticipantId] = useState(assignments[0]?.id ?? "");
  const participant = assignments.find((item) => item.id === participantId);
  const [history, setHistory] = useState<ProgressEntry[]>([]);
  const [completion, setCompletion] = useState(participant?.progressPercent ?? 0);
  const [summary, setSummary] = useState("");
  const [blockers, setBlockers] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!participantId) return;
    void api.get<{ progressUpdates: ProgressEntry[] }>(`/api/projects/${projectId}/participants/${participantId}/progress`).then((result) => setHistory(result.progressUpdates)).catch((caught) => setError(errorMessage(caught)));
  }, [participantId, projectId]);
  useEffect(() => setCompletion(participant?.progressPercent ?? 0), [participant?.progressPercent]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!participant) return;
    try {
      await api.post(`/api/projects/${projectId}/participants/${participant.id}/progress`, {
        participantExpectedRevision: participant.revision,
        completionPercent: completion,
        summary,
        blockers,
        nextSteps,
      });
      setSummary(""); setBlockers(""); setNextSteps("");
      await onChanged();
      const result = await api.get<{ progressUpdates: ProgressEntry[] }>(`/api/projects/${projectId}/participants/${participant.id}/progress`);
      setHistory(result.progressUpdates);
    } catch (caught) { setError(errorMessage(caught)); }
  };
  if (!assignments.length) return <div className="drawer-empty">先添加成员分工，再记录不可变进展。</div>;
  return (
    <section className="drawer-section">
      <label>选择分工<select value={participantId} onChange={(event) => setParticipantId(event.target.value)}>{assignments.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <form className="subform progress-form" onSubmit={submit}>
        <div className="range-label"><span>本次完成比例</span><strong>{completion}%</strong></div>
        <input type="range" min="0" max="100" step="5" value={completion} onChange={(event) => setCompletion(Number(event.target.value))} />
        <label>进展说明<textarea value={summary} onChange={(event) => setSummary(event.target.value)} required rows={3} /></label>
        <label>阻塞问题<textarea value={blockers} onChange={(event) => setBlockers(event.target.value)} rows={2} /></label>
        <label>下一步<textarea value={nextSteps} onChange={(event) => setNextSteps(event.target.value)} rows={2} /></label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={!online}><Plus size={15} />提交进展</button>
      </form>
      <div className="progress-history"><h3>历史记录</h3>{history.map((entry) => <article key={entry.id}><header><strong>{entry.completionPercent}%</strong><time>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time></header><p>{entry.summary}</p>{entry.blockers ? <small className="danger-text">阻塞：{entry.blockers}</small> : null}{entry.nextSteps ? <small>下一步：{entry.nextSteps}</small> : null}</article>)}</div>
    </section>
  );
}

function DependenciesPanel({ projectId, task, schedule, online, onChanged }: { projectId: string; task: Task; schedule: Schedule; online: boolean; onChanged: () => Promise<void> }) {
  const incoming = schedule.dependencies.filter((item) => item.successorTaskId === task.id);
  const [predecessorId, setPredecessorId] = useState("");
  const [error, setError] = useState("");
  const taskName = (id: string) => schedule.tasks.find((item) => item.id === id)?.title ?? "未知任务";
  const add = async () => {
    try { await api.post(`/api/projects/${projectId}/tasks/${task.id}/dependencies`, { predecessorTaskId: predecessorId }); setPredecessorId(""); await onChanged(); } catch (caught) { setError(errorMessage(caught)); }
  };
  const remove = async (id: string, revision: number) => {
    try { await api.delete(`/api/projects/${projectId}/dependencies/${id}`, { expectedRevision: revision }); await onChanged(); } catch (caught) { setError(errorMessage(caught)); }
  };
  return <section className="drawer-section"><div className="section-heading"><div><h3>完成后开始依赖</h3><p>前置任务完成后，本任务才能开始。</p></div><Link2 size={18} /></div><div className="dependency-list">{incoming.map((dependency) => <article key={dependency.id}><span className="dependency-node" /> <strong>{taskName(dependency.predecessorTaskId)}</strong><span>→ 当前任务</span><button className="icon-button" type="button" title="删除依赖" aria-label={`删除来自 ${taskName(dependency.predecessorTaskId)} 的依赖`} onClick={() => void remove(dependency.id, dependency.revision)} disabled={!online || task.status === "done"}><Trash2 size={15} /></button></article>)}</div><div className="inline-add"><select value={predecessorId} onChange={(event) => setPredecessorId(event.target.value)}><option value="">选择前置任务</option>{schedule.tasks.filter((candidate) => candidate.id !== task.id && !incoming.some((item) => item.predecessorTaskId === candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><button className="primary-button" type="button" onClick={() => void add()} disabled={!online || !predecessorId || task.status === "done"}><Plus size={15} />添加</button></div>{error ? <p className="form-error">{error}</p> : null}</section>;
}

function DeliverablesPanel({ projectId, task, schedule, online, onChanged }: { projectId: string; task: Task; schedule: Schedule; online: boolean; onChanged: () => Promise<void> }) {
  const deliverables = schedule.deliverableRequirements.filter((item) => item.taskId === task.id);
  const [title, setTitle] = useState("");
  const [resources, setResources] = useState<ResourceEntity[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => { void api.get<{ resources: ResourceEntity[] }>(`/api/projects/${projectId}/resources`).then((result) => setResources(result.resources)).catch(() => undefined); }, [projectId]);
  const add = async () => { try { await api.post(`/api/projects/${projectId}/tasks/${task.id}/deliverables`, { title }); setTitle(""); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  const fulfill = async (deliverable: Deliverable) => { const resourceId = selected[deliverable.id]; if (!resourceId) return; try { await api.post(`/api/projects/${projectId}/deliverables/${deliverable.id}/fulfill`, { expectedRevision: deliverable.revision, resourceId }); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  const unfulfill = async (deliverable: Deliverable) => { try { await api.post(`/api/projects/${projectId}/deliverables/${deliverable.id}/unfulfill`, { expectedRevision: deliverable.revision }); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  const remove = async (deliverable: Deliverable) => { if (!window.confirm(`删除交付要求“${deliverable.title}”？`)) return; try { await api.delete(`/api/projects/${projectId}/deliverables/${deliverable.id}`, { expectedRevision: deliverable.revision }); await onChanged(); } catch (caught) { setError(errorMessage(caught)); } };
  return <section className="drawer-section"><div className="section-heading"><div><h3>必需交付物</h3><p>全部绑定资料版本后，任务才能进入待验收。</p></div><FileCheck2 size={18} /></div><div className="deliverable-list">{deliverables.map((deliverable) => <article key={deliverable.id} className={deliverable.fulfilledResourceId ? "fulfilled" : ""}><span>{deliverable.fulfilledResourceId ? <CheckCircle2 size={17} /> : <i />}</span><div><strong>{deliverable.title}</strong><small>{deliverable.fulfilledResourceId ? "已绑定资料版本" : "尚未提交"}</small></div>{deliverable.fulfilledResourceId ? <button className="text-button" type="button" onClick={() => void unfulfill(deliverable)} disabled={!online || task.status === "done"}>解除</button> : <div className="fulfill-controls"><select value={selected[deliverable.id] ?? ""} onChange={(event) => setSelected({ ...selected, [deliverable.id]: event.target.value })}><option value="">选择资料</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.title} · v{resource.currentVersionNumber}</option>)}</select><button type="button" onClick={() => void fulfill(deliverable)} disabled={!online || !selected[deliverable.id]}>绑定</button></div>}<button className="icon-button deliverable-remove" type="button" title="删除交付要求" aria-label={`删除 ${deliverable.title}`} onClick={() => void remove(deliverable)} disabled={!online || task.status === "done"}><Trash2 size={14} /></button></article>)}</div><div className="inline-add"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="新增交付要求" /><button className="primary-button" type="button" onClick={() => void add()} disabled={!online || !title || task.status === "done"}><Plus size={15} />添加</button></div>{error ? <p className="form-error">{error}</p> : null}</section>;
}
