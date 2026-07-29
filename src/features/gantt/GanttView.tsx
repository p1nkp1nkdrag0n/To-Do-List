import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  Diamond,
  Flag,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Repeat2,
} from "lucide-react";

import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import type { CollaborationLock, CollaborationPreview } from "../../lib/collaboration-state";
import { addDays, daysBetween, formatMonthDay, inclusiveDays, todayIso } from "../../lib/date";
import type { CollaborationClient } from "../../lib/useCollaboration";
import type { Participant, ProjectDetail, Schedule, Task, WorkStatus } from "../../types";
import { TaskDrawer } from "./TaskDrawer";
import { ScheduleToolsDialog } from "./ScheduleToolsDialog";
import { MilestoneDrawer } from "./MilestoneDrawer";
import {
  barGeometry,
  buildGanttRows,
  currentDayOffset,
  scheduleRange,
  shiftParticipantDates,
  type GanttRow,
} from "./gantt-model";

type TimelineScale = "week" | "month" | "year" | "fit";
type StructureMode = "phase" | "milestone";

interface GanttViewProps {
  project: ProjectDetail;
  currentUserId: string;
  online: boolean;
  collaboration: CollaborationClient;
}

const statusNames: Record<WorkStatus | Participant["status"], string> = {
  not_started: "未开始",
  in_progress: "进行中",
  blocked: "受阻",
  pending_review: "待验收",
  done: "已完成",
};

const ROW_HEIGHT = 36;

interface DragState {
  participant: Participant;
  originX: number;
  offsetDays: number;
}

function conflictText(conflict: Schedule["conflicts"][number]): string {
  switch (conflict.type) {
    case "unallocated_effort": return `有 ${(conflict.unallocatedMinutes / 60).toFixed(1)} 小时无法分配`;
    case "overdue": return `截止 ${conflict.deadline}，任务已逾期`;
    case "missing_availability": return "负责人尚未填写可用时间";
    case "dependency_inversion": return "依赖任务的完成日期晚于后续任务开始日期";
  }
}

function rowHasConflict(row: GanttRow, schedule: Schedule): boolean {
  return schedule.conflicts.some((conflict) => {
    if (conflict.type === "dependency_inversion") {
      return row.taskId === conflict.predecessorTaskId || row.taskId === conflict.successorTaskId;
    }
    return row.entityId === conflict.participantId || row.taskId === conflict.taskId;
  });
}

export function GanttView({ project, currentUserId, online, collaboration }: GanttViewProps) {
  const {
    acquireLock,
    connected: realtimeConnected,
    heartbeat,
    preview: broadcastPreview,
    release,
  } = collaboration;
  const [schedule, setSchedule] = useState<Schedule>();
  const [error, setError] = useState("");
  const [scale, setScale] = useState<TimelineScale>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string>();
  const [creatingTask, setCreatingTask] = useState(false);
  const [structureMode, setStructureMode] = useState<StructureMode>();
  const [showScheduleTools, setShowScheduleTools] = useState(false);
  const [windowShift, setWindowShift] = useState(0);
  const [timelineViewport, setTimelineViewport] = useState(760);
  const [drag, setDrag] = useState<DragState>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineMeasureRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<Schedule>(`/api/projects/${project.project.id}/schedule`);
      setSchedule(next);
      setError("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [project.project.id]);

  useEffect(() => { setSchedule(undefined); setSelectedTaskId(undefined); setSelectedMilestoneId(undefined); void refresh(); }, [refresh]);
  useEffect(() => {
    if (collaboration.invalidationVersion > 0) void refresh();
  }, [collaboration.invalidationVersion, refresh]);
  useEffect(() => {
    const element = timelineMeasureRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setTimelineViewport(entry?.contentRect.width ?? 760));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const baseRange = useMemo(() => schedule ? scheduleRange(schedule) : { start: todayIso(), end: addDays(todayIso(), 42) }, [schedule]);
  const range = useMemo(() => ({ start: addDays(baseRange.start, windowShift), end: addDays(baseRange.end, windowShift) }), [baseRange, windowShift]);
  const days = useMemo(() => inclusiveDays(range.start, range.end), [range]);
  const dayWidth = scale === "week" ? 34 : scale === "month" ? 17 : scale === "year" ? 6 : Math.max(6, Math.min(38, timelineViewport / Math.max(days.length, 1)));
  const timelineWidth = Math.max(timelineViewport, days.length * dayWidth);
  const rows = useMemo(() => schedule ? buildGanttRows(schedule, collapsed) : [], [schedule, collapsed]);
  const selectedTask = schedule?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedMilestone = schedule?.milestones.find((milestone) => milestone.id === selectedMilestoneId);

  const activeParticipantId = drag?.participant.id;
  useEffect(() => {
    if (!activeParticipantId) return;
    const move = (event: PointerEvent) => {
      const active = dragRef.current;
      if (!active || active.participant.id !== activeParticipantId) return;
      const offsetDays = Math.round((event.clientX - active.originX) / dayWidth);
      if (offsetDays === active.offsetDays) return;
      const next = { ...active, offsetDays };
      dragRef.current = next;
      setDrag(next);
      const shifted = shiftParticipantDates(next.participant, offsetDays);
      broadcastPreview(
        next.participant.id,
        shifted.startDate,
        shifted.endDate,
      );
    };
    const end = async () => {
      const active = dragRef.current;
      if (!active || active.participant.id !== activeParticipantId) return;
      dragRef.current = undefined;
      setDrag(undefined);
      try {
        if (active.offsetDays !== 0) {
          await api.patch(`/api/projects/${project.project.id}/participants/${active.participant.id}`, {
            expectedRevision: active.participant.revision,
            ...shiftParticipantDates(active.participant, active.offsetDays),
          });
          await refresh();
        }
      } catch (caught) {
        setError(errorMessage(caught));
        await refresh();
      } finally {
        release(active.participant.id);
      }
    };
    heartbeat(activeParticipantId);
    const heartbeatTimer = setInterval(
      () => heartbeat(activeParticipantId),
      5_000,
    );
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    return () => {
      clearInterval(heartbeatTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [activeParticipantId, broadcastPreview, dayWidth, heartbeat, project.project.id, refresh, release]);

  useEffect(() => {
    if (realtimeConnected || !dragRef.current) return;
    dragRef.current = undefined;
    setDrag(undefined);
    void refresh();
  }, [realtimeConnected, refresh]);

  useEffect(() => () => {
    const active = dragRef.current;
    if (active) release(active.participant.id);
  }, [project.project.id, release]);

  const startDrag = async (event: ReactPointerEvent, participantId: string) => {
    if (!online || !realtimeConnected || !schedule || dragRef.current) return;
    const participant = schedule.participants.find((item) => item.id === participantId);
    if (!participant) return;
    event.preventDefault();
    const originX = event.clientX;
    let pointerReleased = false;
    const markReleased = () => { pointerReleased = true; };
    window.addEventListener("pointerup", markReleased, { once: true });
    window.addEventListener("pointercancel", markReleased, { once: true });
    const granted = await acquireLock(participantId);
    window.removeEventListener("pointerup", markReleased);
    window.removeEventListener("pointercancel", markReleased);
    if (!granted) {
      setError("该分工正在被其他成员调整，请稍后重试。");
      return;
    }
    if (pointerReleased) {
      release(participantId);
      return;
    }
    const next = { participant, originX, offsetDays: 0 };
    dragRef.current = next;
    setDrag(next);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectTask = (taskId: string) => {
    setSelectedMilestoneId(undefined);
    setCreatingTask(false);
    setSelectedTaskId(taskId);
  };

  const selectMilestone = (milestoneId: string) => {
    setSelectedTaskId(undefined);
    setCreatingTask(false);
    setSelectedMilestoneId(milestoneId);
  };

  const goToday = () => {
    setWindowShift(0);
    requestAnimationFrame(() => {
      const offset = currentDayOffset(baseRange.start, dayWidth) - timelineViewport / 2;
      timelineScrollRef.current?.scrollTo({ left: Math.max(0, offset), behavior: "smooth" });
    });
  };

  if (!schedule) {
    return <div className="view-placeholder"><LoaderCircle className="spin" size={22} /><span>{error || "正在读取项目排期"}</span></div>;
  }

  return (
    <div className={`gantt-view ${selectedTaskId !== undefined || selectedMilestoneId !== undefined || creatingTask ? "with-drawer" : ""}`}>
      <section className="gantt-workarea">
        <header className="view-toolbar gantt-toolbar">
          <div className="toolbar-group gantt-range-tools glass-panel" data-tour-id="gantt-range-tools">
            <div className="segmented-control" aria-label="时间尺度">
              {(["week", "month", "year"] as TimelineScale[]).map((item) => (
                <button
                  key={item}
                  className={scale === item ? "active" : ""}
                  type="button"
                  onClick={() => setScale(item)}
                >
                  {item === "week" ? "周" : item === "month" ? "月" : "年"}
                </button>
              ))}
            </div>
            <span className="toolbar-divider" />
            <button className="secondary-button" type="button" title="回到今天" onClick={goToday}>
              <CalendarDays size={16} />今天
            </button>
            <button
              className={`secondary-button ${scale === "fit" ? "active" : ""}`}
              type="button"
              title="适应项目范围"
              onClick={() => {
                setScale("fit");
                setWindowShift(0);
              }}
            >
              <ChevronsLeftRight size={16} />适应项目范围
            </button>
            <div className="date-navigator">
              <button className="icon-button" type="button" title="上一时间段" aria-label="上一时间段" onClick={() => setWindowShift((value) => value - (scale === "year" ? 365 : scale === "month" ? 30 : 7))}><ChevronLeft size={17} /></button>
              <button className="icon-button" type="button" title="下一时间段" aria-label="下一时间段" onClick={() => setWindowShift((value) => value + (scale === "year" ? 365 : scale === "month" ? 30 : 7))}><ChevronRight size={17} /></button>
              <span>{range.start} — {range.end}</span>
            </div>
          </div>
          <div className="toolbar-spacer" />
          <div className="toolbar-group gantt-structure-tools glass-panel" data-tour-id="gantt-structure-tools">
            {schedule.conflicts.length ? <span className="conflict-summary" role="status" title={schedule.conflicts.map(conflictText).join("\n")}><AlertCircle size={16} />{schedule.conflicts.length} 项冲突</span> : null}
            <button className="secondary-button" type="button" title="项目模板与周期任务" onClick={() => setShowScheduleTools(true)}><Repeat2 size={16} />模板与周期</button>
            <button className="secondary-button" type="button" title="添加阶段" onClick={() => setStructureMode("phase")}><Layers3 size={16} />阶段</button>
            <button className="secondary-button" type="button" title="添加里程碑" onClick={() => setStructureMode("milestone")}><Flag size={16} />里程碑</button>
            <button className="primary-button" type="button" data-tour-id="gantt-add-task" onClick={() => { setCreatingTask(true); setSelectedTaskId(undefined); setSelectedMilestoneId(undefined); }}><Plus size={16} />添加任务</button>
          </div>
        </header>
        {error ? <div className="inline-error"><AlertCircle size={16} />{error}<button type="button" onClick={() => void refresh()}><RefreshCw size={14} />重试</button></div> : null}
        <div className="gantt-table" ref={timelineMeasureRef} data-tour-id="gantt-table">
          <div className="gantt-left-pane">
            <div className="gantt-meta-header"><span>阶段 / 任务 / 分工</span><span>负责人</span><span>状态</span><span>进度</span></div>
            {rows.map((row) => (
              <button
                type="button"
                key={row.key}
                className={`gantt-meta-row row-${row.kind} ${row.taskId === selectedTaskId ? "selected" : ""} ${rowHasConflict(row, schedule) ? "has-conflict" : ""}`}
                onClick={() => row.kind === "phase" ? toggleCollapsed(row.key) : row.kind === "milestone" ? selectMilestone(row.entityId) : row.taskId ? selectTask(row.taskId) : undefined}
              >
                <span className="gantt-row-title" style={{ paddingLeft: `${10 + row.depth * 16}px` }}>
                  {row.kind === "phase" || row.kind === "task" ? <ChevronDown className={collapsed.has(row.key) ? "collapsed" : ""} size={14} /> : row.kind === "milestone" ? <Diamond size={11} fill="currentColor" /> : <span className="assignment-dot" style={{ backgroundColor: row.color }} />}
                  <span title={row.label}>{row.label}</span>
                  {rowHasConflict(row, schedule) ? <AlertCircle className="row-alert" size={14} /> : null}
                </span>
                <span title={row.assignee}>{row.assignee}</span>
                <span><i className={`status-badge status-${row.status}`}>{statusNames[row.status]}</i></span>
                <span>{row.progress === null ? "—" : `${row.progress}%`}</span>
              </button>
            ))}
          </div>
          <div className="gantt-timeline-scroll" ref={timelineScrollRef}>
            <div className="timeline-canvas" style={{ width: `${timelineWidth}px` }}>
              <TimelineHeader days={days} dayWidth={dayWidth} />
              <div className="timeline-body" style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
                {rows.map((row, index) => (
                  <TimelineRow
                    key={row.key}
                    row={row}
                    index={index}
                    rangeStart={range.start}
                    dayWidth={dayWidth}
                    timelineWidth={timelineWidth}
                    conflicted={rowHasConflict(row, schedule)}
                    dragOffset={drag?.participant.id === row.entityId ? drag.offsetDays : 0}
                    online={online && realtimeConnected}
                    currentUserId={currentUserId}
                    lock={collaboration.locks[row.entityId]}
                    preview={collaboration.previews[row.entityId]}
                    onPointerDown={(event, participantId) => void startDrag(event, participantId)}
                    onSelectTask={selectTask}
                    onSelectMilestone={selectMilestone}
                  />
                ))}
                <DependencyLayer rows={rows} schedule={schedule} rangeStart={range.start} dayWidth={dayWidth} width={timelineWidth} />
                {daysBetween(range.start, todayIso()) >= 0 && daysBetween(todayIso(), range.end) >= 0 ? <div className="today-line" style={{ left: `${currentDayOffset(range.start, dayWidth)}px` }}><span>今天</span></div> : null}
              </div>
            </div>
          </div>
        </div>
      </section>
      {selectedTaskId !== undefined || creatingTask ? (
        <TaskDrawer project={project} schedule={schedule} task={creatingTask ? null : selectedTask} online={online} onClose={() => { setSelectedTaskId(undefined); setCreatingTask(false); }} onChanged={async () => { await refresh(); if (creatingTask) setCreatingTask(false); }} />
      ) : null}
      {selectedMilestone ? <MilestoneDrawer projectId={project.project.id} schedule={schedule} milestone={selectedMilestone} online={online} onClose={() => setSelectedMilestoneId(undefined)} onChanged={refresh} /> : null}
      {structureMode ? <StructureDialog mode={structureMode} projectId={project.project.id} schedule={schedule} online={online} onClose={() => setStructureMode(undefined)} onCreated={refresh} /> : null}
      {showScheduleTools ? <ScheduleToolsDialog project={project.project} schedule={schedule} online={online} onClose={() => setShowScheduleTools(false)} onChanged={refresh} /> : null}
    </div>
  );
}

function TimelineHeader({ days, dayWidth }: { days: string[]; dayWidth: number }) {
  const groups: Array<{ label: string; count: number }> = [];
  for (const day of days) {
    const label = `${day.slice(0, 4)}年${Number(day.slice(5, 7))}月`;
    const previous = groups.at(-1);
    if (previous?.label === label) previous.count += 1;
    else groups.push({ label, count: 1 });
  }
  return (
    <div className="timeline-header">
      <div className="timeline-months">
        {groups.map((group) => (
          <span key={group.label} style={{ width: `${group.count * dayWidth}px` }}>
            {group.label}
          </span>
        ))}
      </div>
      <div className="timeline-days">
        {days.map((day) => {
          const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
          const show = dayWidth >= 28
            || (dayWidth >= 12 && weekday === 1)
            || day.endsWith("-01");
          return (
            <span
              key={day}
              className={weekday === 0 || weekday === 6 ? "weekend" : ""}
              style={{ width: `${dayWidth}px` }}
            >
              {show ? formatMonthDay(day) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TimelineRow({ row, index, rangeStart, dayWidth, timelineWidth, conflicted, dragOffset, online, currentUserId, lock, preview, onPointerDown, onSelectTask, onSelectMilestone }: { row: GanttRow; index: number; rangeStart: string; dayWidth: number; timelineWidth: number; conflicted: boolean; dragOffset: number; online: boolean; currentUserId: string; lock?: CollaborationLock; preview?: CollaborationPreview; onPointerDown: (event: ReactPointerEvent, participantId: string) => void; onSelectTask: (taskId: string) => void; onSelectMilestone: (milestoneId: string) => void }) {
  const geometry = barGeometry(rangeStart, row.start, row.end, dayWidth);
  const lockedByOther = row.kind === "participant" && lock !== undefined && lock.ownerId !== currentUserId;
  const remotePreview = row.kind === "participant" && preview?.ownerId !== currentUserId
    ? barGeometry(rangeStart, preview?.startDate ?? null, preview?.endDate ?? null, dayWidth)
    : null;
  const canDrag = row.kind === "participant" && online && !lockedByOther;
  return (
    <div
      className={`timeline-row row-${row.kind} ${conflicted ? "has-conflict" : ""}`}
      style={{ top: `${index * ROW_HEIGHT}px`, width: `${timelineWidth}px`, "--day-width": `${dayWidth}px` } as CSSProperties}
      onClick={() => row.kind === "milestone" ? onSelectMilestone(row.entityId) : row.taskId ? onSelectTask(row.taskId) : undefined}
    >
      {remotePreview ? (
        <span
          className="timeline-drag-preview"
          style={{ left: `${remotePreview.left}px`, width: `${remotePreview.width}px` }}
          title={`${preview?.ownerDisplayName ?? "其他成员"} 正在调整`}
        />
      ) : null}
      {geometry ? row.kind === "milestone" ? (
        <span className="milestone-diamond" style={{ left: `${geometry.left}px`, backgroundColor: row.color }} />
      ) : (
        <span
          className={`timeline-bar bar-${row.kind} status-${row.status} ${canDrag ? "draggable" : ""} ${lockedByOther ? "locked" : ""}`}
          style={{ left: `${geometry.left}px`, width: `${geometry.width}px`, backgroundColor: row.kind === "participant" ? row.color : undefined, transform: `translateX(${dragOffset * dayWidth}px)` }}
          onPointerDown={canDrag ? (event) => onPointerDown(event, row.entityId) : undefined}
          title={lockedByOther ? `${lock.ownerDisplayName} 正在调整此分工` : undefined}
        >
          <i style={{ width: `${row.progress ?? 100}%` }} />
          <b>{row.kind === "participant" ? row.assignee : row.label}</b>
        </span>
      ) : null}
      {conflicted ? <AlertCircle className="timeline-alert" size={16} /> : null}
    </div>
  );
}

function DependencyLayer({ rows, schedule, rangeStart, dayWidth, width }: { rows: GanttRow[]; schedule: Schedule; rangeStart: string; dayWidth: number; width: number }) {
  const taskRows = new Map(
    rows.flatMap((row, index) =>
      row.kind === "task" ? [[row.entityId, { row, index }] as const] : [],
    ),
  );
  const paths = schedule.dependencies.flatMap((dependency) => {
    const predecessor = taskRows.get(dependency.predecessorTaskId);
    const successor = taskRows.get(dependency.successorTaskId);
    if (!predecessor || !successor) return [];
    const from = barGeometry(rangeStart, predecessor.row.start, predecessor.row.end, dayWidth);
    const to = barGeometry(rangeStart, successor.row.start, successor.row.end, dayWidth);
    if (!from || !to) return [];
    const x1 = from.left + from.width;
    const y1 = predecessor.index * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = to.left;
    const y2 = successor.index * ROW_HEIGHT + ROW_HEIGHT / 2;
    const bend = Math.max(x1 + 10, x2 - 10);
    return [{ id: dependency.id, points: `${x1},${y1} ${bend},${y1} ${bend},${y2} ${x2},${y2}` }];
  });
  return <svg className="dependency-layer" width={width} height={rows.length * ROW_HEIGHT} aria-hidden="true">{paths.map((path) => <polyline key={path.id} points={path.points} />)}</svg>;
}

function StructureDialog({ mode, projectId, schedule, online, onClose, onCreated }: { mode: StructureMode; projectId: string; schedule: Schedule; online: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [phaseId, setPhaseId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (mode === "phase") await api.post(`/api/projects/${projectId}/phases`, { name, description, startDate: startDate || null, endDate: endDate || null });
      else await api.post(`/api/projects/${projectId}/milestones`, { title: name, description, phaseId: phaseId || null, dueDate: endDate });
      await onCreated(); onClose();
    } catch (caught) { setError(errorMessage(caught)); }
  };
  return <Modal title={mode === "phase" ? "添加阶段" : "添加里程碑"} onClose={onClose} width="small"><form className="modal-body drawer-form" onSubmit={submit}><label>{mode === "phase" ? "阶段名称" : "里程碑名称"}<input value={name} onChange={(event) => setName(event.target.value)} required autoFocus /></label>{mode === "milestone" ? <label>所属阶段<select value={phaseId} onChange={(event) => setPhaseId(event.target.value)}><option value="">未分阶段</option>{schedule.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label> : null}{mode === "phase" ? <div className="form-grid two-columns"><label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div> : <label>截止日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>}<label>说明<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>{error ? <p className="form-error">{error}</p> : null}<footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!online}><Plus size={15} />添加</button></footer></form></Modal>;
}
