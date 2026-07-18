import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Diamond,
  FileCheck2,
  Plus,
  RotateCcw,
  Save,
  Send,
  Trash2,
  X,
} from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import { useSessionDraft } from "../../lib/useSessionDraft";
import type { Deliverable, Milestone, ResourceEntity, Schedule } from "../../types";

type MilestoneTab = "basic" | "deliverables";

const statusNames = {
  not_started: "未开始",
  in_progress: "进行中",
  blocked: "受阻",
  pending_review: "待验收",
  done: "已完成",
} as const;

interface MilestoneDrawerProps {
  projectId: string;
  schedule: Schedule;
  milestone: Milestone;
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export function MilestoneDrawer({ projectId, schedule, milestone, online, onClose, onChanged }: MilestoneDrawerProps) {
  const [tab, setTab] = useState<MilestoneTab>("basic");
  const [form, setForm, clearForm] = useSessionDraft(
    `yancheng.milestoneDraft.${projectId}.${milestone.id}`,
    {
      title: milestone.title,
      description: milestone.description,
      phaseId: milestone.phaseId ?? "",
      dueDate: milestone.dueDate,
      status: milestone.status === "pending_review" || milestone.status === "done" ? "in_progress" : milestone.status,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setTab("basic"); setError(""); }, [milestone.id]);

  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (!online) {
      setError("当前处于离线状态，草稿已保留，恢复连接后再提交。");
      return false;
    }
    setBusy(true); setError("");
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

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.patch(`/api/projects/${projectId}/milestones/${milestone.id}`, {
      expectedRevision: milestone.revision,
      title: form.title,
      description: form.description,
      phaseId: form.phaseId || null,
      dueDate: form.dueDate,
      status: form.status,
    }));
  };
  const transition = () => {
    const action = milestone.status === "done"
      ? "reopen"
      : milestone.status === "pending_review"
        ? "review"
        : "submit-review";
    void run(() => api.post(`/api/projects/${projectId}/milestones/${milestone.id}/${action}`, {
      expectedRevision: milestone.revision,
    }));
  };
  const remove = () => {
    if (!window.confirm(`永久删除里程碑“${milestone.title}”？`)) return;
    void run(() => api.delete(`/api/projects/${projectId}/milestones/${milestone.id}`, {
      expectedRevision: milestone.revision,
    })).then((succeeded) => { if (succeeded) onClose(); });
  };

  const locked = milestone.status === "pending_review" || milestone.status === "done";
  const transitionLabel = milestone.status === "done" ? "重新打开" : milestone.status === "pending_review" ? "验收完成" : "提交验收";
  const TransitionIcon = milestone.status === "done" ? RotateCcw : milestone.status === "pending_review" ? CheckCircle2 : Send;

  return (
    <aside className="detail-drawer" aria-label={`里程碑详情：${milestone.title}`}>
      <header className="drawer-header">
        <div><small>里程碑详情</small><h2>{milestone.title}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情" title="关闭"><X size={19} /></button>
      </header>
      <div className="drawer-status-row"><span className={`status-badge status-${milestone.status}`}>{statusNames[milestone.status]}</span><span>修订 {milestone.revision}</span></div>
      <nav className="drawer-tabs milestone-tabs">
        <button type="button" className={tab === "basic" ? "active" : ""} onClick={() => setTab("basic")}>基本信息</button>
        <button type="button" className={tab === "deliverables" ? "active" : ""} onClick={() => setTab("deliverables")}>交付物</button>
      </nav>
      <div className="drawer-body">
        {tab === "basic" ? <form className="drawer-form" onSubmit={save}>
          {milestone.status === "done" ? <div className="locked-notice"><CheckCircle2 size={17} />里程碑已验收，重新打开后才能修改。</div> : milestone.status === "pending_review" ? <div className="locked-notice pending"><Send size={17} />里程碑正在等待项目成员验收。</div> : null}
          <label>里程碑名称<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} disabled={locked} /></label>
          <div className="form-grid two-columns"><label>所属阶段<select value={form.phaseId} onChange={(event) => setForm({ ...form, phaseId: event.target.value })} disabled={locked}><option value="">未分阶段</option>{schedule.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label><label>执行状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "not_started" | "in_progress" | "blocked" })} disabled={locked}><option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="blocked">受阻</option></select></label></div>
          <label>截止日期<input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} required disabled={locked} /></label>
          <label>说明<textarea rows={6} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} disabled={locked} /></label>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="drawer-primary-actions"><button className="secondary-button" type="button" onClick={transition} disabled={!online || busy}><TransitionIcon size={16} />{transitionLabel}</button><button className="primary-button" type="submit" disabled={!online || busy || locked}><Save size={16} />保存里程碑</button></div>
          <div className="drawer-danger-actions"><button type="button" onClick={remove} disabled={!online || busy || milestone.status === "done"}><Trash2 size={15} />删除里程碑</button></div>
        </form> : <MilestoneDeliverables projectId={projectId} milestone={milestone} schedule={schedule} online={online} onChanged={onChanged} />}
      </div>
    </aside>
  );
}

function MilestoneDeliverables({ projectId, milestone, schedule, online, onChanged }: { projectId: string; milestone: Milestone; schedule: Schedule; online: boolean; onChanged: () => Promise<void> }) {
  const deliverables = schedule.deliverableRequirements.filter((item) => item.milestoneId === milestone.id);
  const [title, setTitle] = useState("");
  const [resources, setResources] = useState<ResourceEntity[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    void api.get<{ resources: ResourceEntity[] }>(`/api/projects/${projectId}/resources`).then((result) => setResources(result.resources)).catch((caught) => setError(errorMessage(caught)));
  }, [projectId]);
  const run = async (operation: () => Promise<unknown>) => {
    setError("");
    try { await operation(); await onChanged(); } catch (caught) { setError(errorMessage(caught)); }
  };
  const add = () => void run(async () => {
    await api.post(`/api/projects/${projectId}/milestones/${milestone.id}/deliverables`, { title });
    setTitle("");
  });
  const fulfill = (deliverable: Deliverable) => {
    const resourceId = selected[deliverable.id];
    if (!resourceId) return;
    void run(() => api.post(`/api/projects/${projectId}/deliverables/${deliverable.id}/fulfill`, { expectedRevision: deliverable.revision, resourceId }));
  };
  const unfulfill = (deliverable: Deliverable) => void run(() => api.post(`/api/projects/${projectId}/deliverables/${deliverable.id}/unfulfill`, { expectedRevision: deliverable.revision }));
  const remove = (deliverable: Deliverable) => {
    if (!window.confirm(`删除交付要求“${deliverable.title}”？`)) return;
    void run(() => api.delete(`/api/projects/${projectId}/deliverables/${deliverable.id}`, { expectedRevision: deliverable.revision }));
  };

  return <section className="drawer-section"><div className="section-heading"><div><h3>必需交付物</h3><p>全部绑定资料版本后，里程碑才能提交验收。</p></div><FileCheck2 size={18} /></div><div className="deliverable-list">{deliverables.map((deliverable) => <article key={deliverable.id} className={deliverable.fulfilledResourceId ? "fulfilled" : ""}><span>{deliverable.fulfilledResourceId ? <CheckCircle2 size={17} /> : <Diamond size={14} />}</span><div><strong>{deliverable.title}</strong><small>{deliverable.fulfilledResourceId ? "已绑定资料版本" : "尚未提交"}</small></div>{deliverable.fulfilledResourceId ? <button className="text-button" type="button" onClick={() => unfulfill(deliverable)} disabled={!online || milestone.status === "done"}>解除</button> : <div className="fulfill-controls"><select value={selected[deliverable.id] ?? ""} onChange={(event) => setSelected({ ...selected, [deliverable.id]: event.target.value })}><option value="">选择资料</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.title} · v{resource.currentVersionNumber}</option>)}</select><button type="button" onClick={() => fulfill(deliverable)} disabled={!online || !selected[deliverable.id]}>绑定</button></div>}<button className="icon-button deliverable-remove" type="button" title="删除交付要求" aria-label={`删除 ${deliverable.title}`} onClick={() => remove(deliverable)} disabled={!online || milestone.status === "done"}><Trash2 size={14} /></button></article>)}</div><div className="inline-add"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="新增交付要求" /><button className="primary-button" type="button" onClick={add} disabled={!online || !title.trim() || milestone.status === "done"}><Plus size={15} />添加</button></div>{error ? <p className="form-error">{error}</p> : null}</section>;
}
