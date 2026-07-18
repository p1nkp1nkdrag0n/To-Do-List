import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  CalendarPlus,
  Check,
  CopyPlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Repeat2,
  Save,
} from "lucide-react";

import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import { addDays, todayIso } from "../../lib/date";
import type {
  Project,
  RecurringRule,
  Schedule,
  ScheduleTemplateList,
  TeamScheduleTemplate,
} from "../../types";
import { formatRecurringPattern, templateStructureSummary } from "./schedule-tools-model";

interface ScheduleToolsDialogProps {
  project: Project;
  schedule: Schedule;
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

type ToolsTab = "templates" | "recurring";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function ScheduleToolsDialog({ project, schedule, online, onClose, onChanged }: ScheduleToolsDialogProps) {
  const [tab, setTab] = useState<ToolsTab>("templates");
  const [templates, setTemplates] = useState<ScheduleTemplateList>();
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [templateResult, ruleResult] = await Promise.all([
        api.get<ScheduleTemplateList>("/api/projects/templates"),
        api.get<{ recurringRules: RecurringRule[] }>(`/api/projects/${project.id}/recurring-rules`),
      ]);
      setTemplates(templateResult);
      setRules(ruleResult.recurringRules);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Modal title="模板与周期" width="large" onClose={onClose}>
      <div className="schedule-tools">
        <nav className="dialog-tabs" aria-label="排期工具">
          <button type="button" className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}><CopyPlus size={15} />项目模板</button>
          <button type="button" className={tab === "recurring" ? "active" : ""} onClick={() => setTab("recurring")}><Repeat2 size={15} />周期任务</button>
        </nav>
        {error ? <p className="form-error schedule-tools-message">{error}</p> : null}
        {notice ? <p className="form-notice schedule-tools-message"><Check size={15} />{notice}</p> : null}
        {loading ? <div className="table-loading"><LoaderCircle className="spin" size={20} />正在读取排期工具</div> : tab === "templates" && templates ? (
          <TemplateTools
            project={project}
            templates={templates}
            online={online}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            setNotice={setNotice}
            reload={load}
            onChanged={onChanged}
          />
        ) : (
          <RecurringTools
            project={project}
            schedule={schedule}
            rules={rules}
            online={online}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            setNotice={setNotice}
            reload={load}
            onChanged={onChanged}
          />
        )}
      </div>
    </Modal>
  );
}

function TemplateTools({ project, templates, online, busy, setBusy, setError, setNotice, reload, onChanged }: {
  project: Project;
  templates: ScheduleTemplateList;
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  reload: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [anchorDate, setAnchorDate] = useState(project.startDate ?? todayIso());
  const [templateNames, setTemplateNames] = useState<Record<string, string>>(() => Object.fromEntries(templates.team.map((template) => [template.id, template.name])));

  useEffect(() => {
    setTemplateNames(Object.fromEntries(templates.team.map((template) => [template.id, template.name])));
  }, [templates.team]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  };
  const apply = (templateId: string, templateName: string) => {
    if (!window.confirm(`将“${templateName}”追加到当前项目，并以 ${anchorDate} 为基准日期？`)) return;
    void run(async () => {
      await api.post(`/api/projects/${project.id}/templates/${templateId}/apply`, { anchorDate });
      await onChanged();
      setNotice(`已应用“${templateName}”`);
    });
  };
  const saveCurrent = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.post(`/api/projects/${project.id}/templates`, { name, anchorDate });
      setName("");
      await reload();
      setNotice("当前结构已保存为团队模板");
    });
  };
  const rename = (template: TeamScheduleTemplate) => void run(async () => {
    await api.patch(`/api/projects/templates/${template.id}`, {
      expectedRevision: template.revision,
      name: templateNames[template.id],
    });
    await reload();
    setNotice("模板名称已更新");
  });
  const archive = (template: TeamScheduleTemplate) => {
    if (!window.confirm(`归档团队模板“${template.name}”？`)) return;
    void run(async () => {
      await api.delete(`/api/projects/templates/${template.id}`, { expectedRevision: template.revision });
      await reload();
      setNotice("团队模板已归档");
    });
  };

  return (
    <div className="schedule-tools-body">
      <section className="template-anchor">
        <div><h3>应用项目模板</h3><p>模板只追加阶段、任务、依赖、里程碑和交付要求，不复制成员、进展或资料。</p></div>
        <label>模板基准日期<input type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} /></label>
      </section>
      <div className="template-list">
        {templates.builtIn.map((template) => (
          <article className="template-row" key={template.id}>
            <span className="template-kind"><CalendarPlus size={17} /></span>
            <div><strong>{template.name}</strong><small>{templateStructureSummary(template.payload)}</small></div>
            <button className="secondary-button" type="button" onClick={() => apply(template.id, template.name)} disabled={!online || busy}><Play size={15} />应用</button>
          </article>
        ))}
      </div>
      <section className="save-template-section">
        <header><div><h3>团队模板</h3><p>将当前项目结构沉淀为团队可重复使用的排期骨架。</p></div><span>{templates.team.length} 个</span></header>
        <form className="inline-template-form" onSubmit={saveCurrent}>
          <label>模板名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：校赛答辩排期" required /></label>
          <button className="primary-button" type="submit" disabled={!online || busy || !name.trim()}><Save size={15} />保存当前结构</button>
        </form>
        <div className="team-template-list">
          {templates.team.length === 0 ? <p className="compact-empty">暂无团队模板</p> : templates.team.map((template) => (
            <article key={template.id}>
              <input aria-label={`${template.name} 模板名称`} value={templateNames[template.id] ?? template.name} onChange={(event) => setTemplateNames((current) => ({ ...current, [template.id]: event.target.value }))} />
              <small>{templateStructureSummary(template.payload)}</small>
              <button className="icon-button" type="button" title="保存模板名称" aria-label={`保存 ${template.name} 模板名称`} onClick={() => rename(template)} disabled={!online || busy || !(templateNames[template.id] ?? "").trim()}><Pencil size={15} /></button>
              <button className="icon-button" type="button" title="归档模板" aria-label={`归档 ${template.name}`} onClick={() => archive(template)} disabled={!online || busy}><Archive size={15} /></button>
              <button className="secondary-button" type="button" onClick={() => apply(template.id, template.name)} disabled={!online || busy}><Play size={15} />应用</button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function RecurringTools({ project, schedule, rules, online, busy, setBusy, setError, setNotice, reload, onChanged }: {
  project: Project;
  schedule: Schedule;
  rules: RecurringRule[];
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  reload: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const sourceTasks = useMemo(() => schedule.tasks.filter((task) => task.recurringRuleId === null && task.status !== "done"), [schedule.tasks]);
  const defaultStart = project.startDate ?? todayIso();
  const [editingId, setEditingId] = useState<string>();
  const [sourceTaskId, setSourceTaskId] = useState(sourceTasks[0]?.id ?? "");
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("weekly");
  const [intervalCount, setIntervalCount] = useState(1);
  const [dayOfWeek, setDayOfWeek] = useState(weekday(defaultStart));
  const [dayOfMonth, setDayOfMonth] = useState(Number(defaultStart.slice(8, 10)));
  const [startsOn, setStartsOn] = useState(defaultStart);
  const [endsOn, setEndsOn] = useState("");
  const [generateThrough, setGenerateThrough] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sourceTaskId && sourceTasks[0]) setSourceTaskId(sourceTasks[0].id);
  }, [sourceTaskId, sourceTasks]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  };
  const reset = () => {
    setEditingId(undefined);
    setSourceTaskId(sourceTasks[0]?.id ?? "");
    setFrequency("weekly"); setIntervalCount(1); setDayOfWeek(weekday(defaultStart));
    setDayOfMonth(Number(defaultStart.slice(8, 10))); setStartsOn(defaultStart); setEndsOn("");
  };
  const edit = (rule: RecurringRule) => {
    setEditingId(rule.id); setSourceTaskId(rule.sourceTaskId); setFrequency(rule.frequency);
    setIntervalCount(rule.intervalCount); setDayOfWeek(rule.dayOfWeek ?? 1); setDayOfMonth(rule.dayOfMonth ?? 1);
    setStartsOn(rule.startsOn); setEndsOn(rule.endsOn ?? "");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = {
      frequency,
      intervalCount,
      ...(frequency === "weekly" ? { dayOfWeek } : { dayOfMonth }),
      startsOn,
      endsOn: endsOn || null,
    };
    void run(async () => {
      if (editingId) {
        const rule = rules.find((item) => item.id === editingId)!;
        await api.patch(`/api/projects/${project.id}/recurring-rules/${editingId}`, { expectedRevision: rule.revision, ...body });
        setNotice("周期规则已更新，已生成实例保持不变");
      } else {
        await api.post(`/api/projects/${project.id}/recurring-rules`, { sourceTaskId, ...body });
        setNotice("周期规则已创建");
      }
      reset(); await reload(); await onChanged();
    });
  };
  const toggle = (rule: RecurringRule) => void run(async () => {
    await api.patch(`/api/projects/${project.id}/recurring-rules/${rule.id}`, { expectedRevision: rule.revision, isActive: !rule.isActive });
    await reload(); await onChanged();
    setNotice(rule.isActive ? "周期规则已停用" : "周期规则已启用");
  });
  const generate = (rule: RecurringRule) => void run(async () => {
    const throughDate = generateThrough[rule.id] ?? addDays(rule.nextOccurrenceOn, 28);
    const result = await api.post<{ tasks: unknown[] }>(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`, { expectedRevision: rule.revision, throughDate });
    await reload(); await onChanged();
    setNotice(`已生成 ${result.tasks.length} 个独立任务实例`);
  });

  return (
    <div className="schedule-tools-body recurring-tools">
      <form className="recurring-form" onSubmit={submit}>
        <header><div><h3>{editingId ? "编辑周期规则" : "新建周期规则"}</h3><p>实例独立保存，后续规则变更只影响尚未生成的日期。</p></div>{editingId ? <button className="text-button" type="button" onClick={reset}>取消编辑</button> : null}</header>
        <label>来源任务<select value={sourceTaskId} onChange={(event) => setSourceTaskId(event.target.value)} disabled={Boolean(editingId)} required><option value="">选择任务</option>{sourceTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <div className="form-grid two-columns">
          <label>重复方式<select value={frequency} onChange={(event) => setFrequency(event.target.value as "weekly" | "monthly")}><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
          <label>间隔<input type="number" min="1" max="52" value={intervalCount} onChange={(event) => setIntervalCount(Number(event.target.value))} /></label>
        </div>
        {frequency === "weekly" ? <label>每周日期<select value={dayOfWeek} onChange={(event) => setDayOfWeek(Number(event.target.value))}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label> : <label>每月日期<input type="number" min="1" max="31" value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))} /></label>}
        <div className="form-grid two-columns"><label>开始日期<input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} required /></label><label>结束日期<input type="date" min={startsOn} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} /></label></div>
        <button className="primary-button" type="submit" disabled={!online || busy || !sourceTaskId}><Plus size={15} />{editingId ? "保存周期规则" : "创建周期规则"}</button>
      </form>
      <section className="recurring-rule-list">
        <header><h3>现有规则</h3><span>{rules.length} 条</span></header>
        {rules.length === 0 ? <p className="compact-empty">暂无周期规则</p> : rules.map((rule) => {
          const source = schedule.tasks.find((task) => task.id === rule.sourceTaskId);
          return <article className={`recurring-rule-row ${rule.isActive ? "" : "inactive"}`} key={rule.id}>
            <div className="rule-summary"><span><Repeat2 size={16} /></span><div><strong>{source?.title ?? "源任务已归档"}</strong><small>{formatRecurringPattern(rule)} · 下次 {rule.nextOccurrenceOn}{rule.endsOn ? ` · 截止 ${rule.endsOn}` : ""}</small></div><i>{rule.isActive ? "启用" : "停用"}</i></div>
            <div className="rule-actions"><label>生成至<input type="date" min={rule.nextOccurrenceOn} value={generateThrough[rule.id] ?? addDays(rule.nextOccurrenceOn, 28)} onChange={(event) => setGenerateThrough((current) => ({ ...current, [rule.id]: event.target.value }))} /></label><button className="secondary-button" type="button" onClick={() => generate(rule)} disabled={!online || busy || !rule.isActive}><Play size={14} />生成实例</button><button className="icon-button" type="button" title="编辑规则" aria-label={`编辑 ${source?.title ?? "周期"} 规则`} onClick={() => edit(rule)} disabled={!online || busy}><Pencil size={14} /></button><button className="text-button" type="button" onClick={() => toggle(rule)} disabled={!online || busy}>{rule.isActive ? "停用" : "启用"}</button></div>
          </article>;
        })}
      </section>
    </div>
  );
}
