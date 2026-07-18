import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarPlus,
  Check,
  ChevronDown,
  Clock3,
  Info,
  LoaderCircle,
  LockKeyhole,
  Minus,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import { addDays, minutesToTime, timeToMinutes, todayIso, weekdayChinese } from "../../lib/date";
import type {
  AvailabilityDocument,
  ProjectAvailabilitySummary,
  Schedule,
  WeeklyAvailabilitySlot,
} from "../../types";
import { setHalfHourSlot, slotContains } from "./availability-model";

interface AvailabilityViewProps {
  projectId: string;
  currentUserId: string;
  online: boolean;
  invalidationVersion: number;
}

type AvailabilityException = AvailabilityDocument["profiles"][number]["exceptions"][number];
type DraftProfile = Omit<AvailabilityDocument["profiles"][number], "id" | "revision"> & {
  id?: string;
};

const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const GRID_START = 7 * 60;
const GRID_END = 23 * 60;
const HALF_HOURS = Array.from({ length: (GRID_END - GRID_START) / 30 }, (_, index) => GRID_START + index * 30);

function toDraft(document: AvailabilityDocument): DraftProfile[] {
  return document.profiles.map(({ revision: _revision, ...profile }) => ({ ...profile }));
}

function profileForDate<T extends { validFrom: string; validThrough: string }>(profiles: T[], date: string): T | undefined {
  return profiles.find((profile) => profile.validFrom <= date && profile.validThrough >= date) ?? profiles[0];
}

export function AvailabilityView({ projectId, currentUserId, online, invalidationVersion }: AvailabilityViewProps) {
  const [document, setDocument] = useState<AvailabilityDocument>();
  const [profiles, setProfiles] = useState<DraftProfile[]>([]);
  const [summary, setSummary] = useState<ProjectAvailabilitySummary>();
  const [schedule, setSchedule] = useState<Schedule>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [exceptionDate, setExceptionDate] = useState(todayIso());
  const [exceptionKind, setExceptionKind] = useState<"available" | "unavailable">("unavailable");
  const [exceptionStart, setExceptionStart] = useState("09:00");
  const [exceptionEnd, setExceptionEnd] = useState("12:00");
  const [exceptionNote, setExceptionNote] = useState("");
  const painting = useRef<{ available: boolean; visited: Set<string> } | undefined>(undefined);

  const load = useCallback(async () => {
    setError("");
    try {
      const [own, projectSummary, projectSchedule] = await Promise.all([
        api.get<AvailabilityDocument>("/api/me/availability"),
        api.get<ProjectAvailabilitySummary>(`/api/projects/${projectId}/availability`),
        api.get<Schedule>(`/api/projects/${projectId}/schedule`),
      ]);
      setDocument(own);
      setProfiles(toDraft(own));
      setSummary(projectSummary);
      setSchedule(projectSchedule);
      setActiveIndex(Math.max(0, own.profiles.findIndex((profile) => profile.validFrom <= todayIso() && profile.validThrough >= todayIso())));
      setDirty(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (invalidationVersion > 0) void load();
  }, [invalidationVersion, load]);
  useEffect(() => {
    const stop = () => { painting.current = undefined; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  const profile = profiles[activeIndex];
  const updateProfile = (patch: Partial<DraftProfile>) => {
    setProfiles((current) => current.map((item, index) => index === activeIndex ? { ...item, ...patch } : item));
    setDirty(true);
  };

  const paintCell = (dayOfWeek: number, minute: number, start: boolean) => {
    if (!profile || !online) return;
    const key = `${dayOfWeek}:${minute}`;
    if (start) {
      painting.current = {
        available: !slotContains(profile.weeklySlots, dayOfWeek, minute),
        visited: new Set(),
      };
    }
    if (!painting.current || painting.current.visited.has(key)) return;
    painting.current.visited.add(key);
    updateProfile({
      weeklySlots: setHalfHourSlot(
        profile.weeklySlots,
        dayOfWeek,
        minute,
        painting.current.available,
      ),
    });
  };

  const addProfile = () => {
    const last = profiles.at(-1);
    const validFrom = last ? addDays(last.validThrough, 1) : todayIso();
    setProfiles((current) => [...current, {
      validFrom,
      validThrough: addDays(validFrom, 150),
      weeklyCapacityMinutes: 1_200,
      privateNote: "",
      weeklySlots: [],
      exceptions: [],
    }]);
    setActiveIndex(profiles.length);
    setDirty(true);
  };

  const removeProfile = () => {
    if (!profile || !window.confirm("删除这个学期的可用时间模板？")) return;
    setProfiles((current) => current.filter((_, index) => index !== activeIndex));
    setActiveIndex((index) => Math.max(0, index - 1));
    setDirty(true);
  };

  const addException = () => {
    if (!profile) return;
    const next: AvailabilityException = {
      exceptionDate,
      kind: exceptionKind,
      startMinute: timeToMinutes(exceptionStart),
      endMinute: timeToMinutes(exceptionEnd),
      privateNote: exceptionNote,
    };
    updateProfile({ exceptions: [...profile.exceptions, next].sort((left, right) => left.exceptionDate.localeCompare(right.exceptionDate)) });
    setExceptionNote("");
  };

  const save = async () => {
    if (!document || !online) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api.put<AvailabilityDocument>("/api/me/availability", {
        expectedRevision: document.revision,
        profiles,
      });
      setDocument(saved);
      setProfiles(toDraft(saved));
      setSummary(await api.get<ProjectAvailabilitySummary>(`/api/projects/${projectId}/availability`));
      setDirty(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  if (!document || !summary || !schedule) {
    return <div className="view-placeholder"><LoaderCircle className="spin" size={22} /><span>{error || "正在读取可用时间"}</span></div>;
  }

  return (
    <div className="availability-view">
      <header className="availability-heading">
        <div><h1>我的可用时间</h1><div className="profile-switch"><select value={activeIndex} onChange={(event) => setActiveIndex(Number(event.target.value))}>{profiles.map((item, index) => <option key={item.id ?? `${item.validFrom}-${index}`} value={index}>{item.validFrom} — {item.validThrough}</option>)}</select><ChevronDown size={14} /></div>{profile ? <span><Clock3 size={15} />{profile.validFrom} 至 {profile.validThrough}</span> : null}</div>
        <div><button className="secondary-button" type="button" onClick={addProfile}><CalendarPlus size={16} />添加学期</button>{profile ? <button className="icon-button" type="button" onClick={removeProfile} disabled={!online} title="删除当前学期" aria-label="删除当前学期"><Trash2 size={16} /></button> : null}<button className="primary-button" type="button" onClick={() => void save()} disabled={!online || !dirty || saving}><Save size={16} />{saving ? "保存中…" : "保存更改"}</button></div>
      </header>
      {error ? <div className="inline-error"><AlertCircle size={15} />{error}</div> : null}
      {profile ? <div className="availability-editor"><div className="weekly-grid"><div className="weekly-grid-header"><span />{DAY_NAMES.slice(1).concat(DAY_NAMES[0]!).map((day) => <strong key={day}>{day}</strong>)}</div><div className="weekly-grid-body"><div className="time-labels">{HALF_HOURS.map((minute) => <span key={minute}>{minute % 60 === 0 ? minutesToTime(minute) : ""}</span>)}</div>{[1, 2, 3, 4, 5, 6, 0].map((day) => <div className="day-column" key={day}>{HALF_HOURS.map((minute) => { const selected = slotContains(profile.weeklySlots, day, minute); return <button key={minute} type="button" className={selected ? "available" : ""} onPointerDown={(event) => { event.preventDefault(); paintCell(day, minute, true); }} onPointerEnter={() => paintCell(day, minute, false)} title={`${DAY_NAMES[day]} ${minutesToTime(minute)}–${minutesToTime(minute + 30)}`} aria-label={`${DAY_NAMES[day]} ${minutesToTime(minute)} ${selected ? "可用" : "不可用"}`} />; })}</div>)}</div></div><aside className="availability-settings"><h2>时间设置</h2><label>每周投入上限（小时）<div className="number-stepper"><input type="number" min="0" max="168" step="0.5" value={profile.weeklyCapacityMinutes / 60} onChange={(event) => updateProfile({ weeklyCapacityMinutes: Math.round(Number(event.target.value) * 60) })} /><button type="button" title="减少每周投入上限" aria-label="减少每周投入上限" onClick={() => updateProfile({ weeklyCapacityMinutes: Math.max(0, profile.weeklyCapacityMinutes - 30) })}><Minus size={14} /></button><button type="button" title="增加每周投入上限" aria-label="增加每周投入上限" onClick={() => updateProfile({ weeklyCapacityMinutes: Math.min(10080, profile.weeklyCapacityMinutes + 30) })}><Plus size={14} /></button></div></label><div className="form-grid two-columns"><label>学期开始<input type="date" value={profile.validFrom} onChange={(event) => updateProfile({ validFrom: event.target.value })} /></label><label>学期结束<input type="date" min={profile.validFrom} value={profile.validThrough} onChange={(event) => updateProfile({ validThrough: event.target.value })} /></label></div><label>仅自己可见的备注 <LockKeyhole size={13} /><textarea rows={3} maxLength={2000} value={profile.privateNote} onChange={(event) => updateProfile({ privateNote: event.target.value })} placeholder="课程、个人安排或家庭事项" /></label><section className="exception-editor"><h3>临时例外</h3><label>日期<input type="date" value={exceptionDate} onChange={(event) => setExceptionDate(event.target.value)} /></label><div className="segmented-control"><button type="button" className={exceptionKind === "available" ? "active available-mode" : ""} onClick={() => setExceptionKind("available")}>临时可用</button><button type="button" className={exceptionKind === "unavailable" ? "active" : ""} onClick={() => setExceptionKind("unavailable")}>临时不可用</button></div><div className="form-grid two-columns"><label>开始<input type="time" step="1800" value={exceptionStart} onChange={(event) => setExceptionStart(event.target.value)} /></label><label>结束<input type="time" step="1800" value={exceptionEnd} onChange={(event) => setExceptionEnd(event.target.value)} /></label></div><label>私人备注<input value={exceptionNote} onChange={(event) => setExceptionNote(event.target.value)} maxLength={2000} /></label><button className="secondary-button" type="button" onClick={addException} disabled={!online || exceptionStart >= exceptionEnd}><Plus size={15} />添加例外</button></section><div className="exception-list">{profile.exceptions.map((exception, index) => <article key={`${exception.exceptionDate}-${exception.startMinute}-${index}`}><i className={exception.kind} /><div><strong>{exception.exceptionDate}（周{weekdayChinese(exception.exceptionDate)}）</strong><small>{exception.kind === "available" ? "可用" : "不可用"} · {minutesToTime(exception.startMinute)}–{minutesToTime(exception.endMinute)}</small></div><button className="icon-button" type="button" title={`删除 ${exception.exceptionDate} 的临时例外`} aria-label={`删除 ${exception.exceptionDate} 的临时例外`} onClick={() => updateProfile({ exceptions: profile.exceptions.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={14} /></button></article>)}</div></aside></div> : <div className="availability-empty"><Clock3 size={25} /><h2>尚未建立学期模板</h2><button className="primary-button" type="button" onClick={addProfile}><Plus size={16} />添加学期</button></div>}
      <TeamCapacityTable summary={summary} schedule={schedule} currentUserId={currentUserId} />
      <footer className="availability-privacy"><div><span className="available-swatch" />可用 <span className="busy-swatch" />不可用 / 忙碌 <span className="missing-swatch" />缺少可用时间 <span className="overload-swatch" />超过每周上限</div><p><LockKeyhole size={13} />团队成员只能看到忙闲区间、容量和冲突结果，不会看到你的私人备注。</p></footer>
    </div>
  );
}

function TeamCapacityTable({ summary, schedule, currentUserId }: { summary: ProjectAvailabilitySummary; schedule: Schedule; currentUserId: string }) {
  const today = todayIso();
  const days = [1, 2, 3, 4, 5, 6, 0];
  const rows = useMemo(() => summary.members.map((member) => {
    const profile = profileForDate(member.profiles, today);
    const assignments = schedule.participants.filter((participant) => participant.userId === member.userId && participant.status !== "done");
    const assigned = assignments.reduce((sum, participant) => sum + participant.estimatedMinutes * (1 - participant.progressPercent / 100), 0);
    const capacity = profile?.weeklyCapacityMinutes ?? 0;
    const conflictCount = schedule.conflicts.filter((conflict) => "userId" in conflict && conflict.userId === member.userId).length;
    return { member, profile, assigned, capacity, remaining: capacity - assigned, conflictCount };
  }), [schedule.conflicts, schedule.participants, summary.members, today]);
  return <section className="team-capacity"><header><h2>团队成员可用时间概览</h2><Info size={14} /></header><div className="capacity-header"><span>成员</span><span>每周上限</span><span>本周安排</span><span className="capacity-days">{days.map((day) => <i key={day}>{DAY_NAMES[day]}</i>)}</span><span>剩余</span><span>冲突</span></div>{rows.map(({ member, profile, assigned, capacity, remaining, conflictCount }) => <div className={`capacity-row ${remaining < 0 || conflictCount ? "warning" : ""}`} key={member.userId}><span className="capacity-member"><i className="avatar" style={{ backgroundColor: member.color }}>{member.displayName.slice(0, 1)}</i><strong>{member.displayName}{member.userId === currentUserId ? "（我）" : ""}</strong></span><span>{(capacity / 60).toFixed(1)}h</span><span>{(assigned / 60).toFixed(1)}h</span><span className="capacity-bars">{days.map((day) => { const minutes = profile?.weeklySlots.filter((slot) => slot.dayOfWeek === day).reduce((sum, slot) => sum + slot.endMinute - slot.startMinute, 0) ?? 0; return <i key={day}><b style={{ width: `${Math.min(100, minutes / (8 * 60) * 100)}%` }} /></i>; })}</span><span className={remaining < 0 ? "danger-text" : "success-text"}>{(remaining / 60).toFixed(1)}h</span><span className={conflictCount ? "danger-text" : ""}>{conflictCount}</span></div>)}</section>;
}
