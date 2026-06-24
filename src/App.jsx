import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Folder,
  FolderPlus,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Save,
  Trash2,
  Users,
  X
} from "lucide-react";
import { api, createSocket, getStoredToken, storeToken } from "./api.js";
import { chooseProjectId, matchingProjectState } from "./projectSelection.js";
import {
  addDays,
  dateTimeLocal,
  daysBetween,
  eventDate,
  getPeriod,
  minutesFromDateTime,
  rangePosition,
  setMinutesOnDate,
  shiftSelectedDate,
  todayDate
} from "./dateUtils.js";

const statusLabels = {
  todo: "待办",
  doing: "进行中",
  done: "完成"
};

const scaleLabels = {
  day: "日",
  week: "周",
  month: "月",
  year: "年"
};

const dailyCapacityHours = 12;

function emptyAssignmentForm(today) {
  return {
    taskId: "",
    userId: "",
    startDate: today,
    endDate: today,
    status: "todo"
  };
}

function normalizeError(error) {
  return error?.message || "操作失败";
}

function buildTaskTree(tasks) {
  const byParent = new Map();
  for (const task of tasks) {
    const key = task.parentId || "root";
    byParent.set(key, [...(byParent.get(key) || []), task]);
  }
  return byParent;
}

function flattenRows(tasks, assignments, expanded) {
  const byParent = buildTaskTree(tasks);
  const assignmentsByTask = new Map();
  for (const assignment of assignments) {
    assignmentsByTask.set(assignment.taskId, [...(assignmentsByTask.get(assignment.taskId) || []), assignment]);
  }
  const rows = [];
  const visit = (parentId, depth) => {
    for (const task of byParent.get(parentId || "root") || []) {
      const hasChildren = (byParent.get(task.id) || []).length > 0;
      rows.push({ type: "task", task, depth, hasChildren });
      if (expanded[task.id] !== false) {
        for (const assignment of assignmentsByTask.get(task.id) || []) {
          rows.push({ type: "assignment", assignment, task, depth: depth + 1 });
        }
        visit(task.id, depth + 1);
      }
    }
  };
  visit(null, 0);
  return rows;
}

function formatRequest(request) {
  if (request.type === "assignment_update") {
    return `调整任务时间/状态：${request.payload.startDate} - ${request.payload.endDate}，${statusLabels[request.payload.status]}`;
  }
  if (request.type === "personal_to_team_assignment") {
    return `个人日程加入已有任务：${request.payload.startDate} - ${request.payload.endDate}`;
  }
  if (request.type === "personal_to_team_task") {
    return `个人日程创建团队任务：${request.payload.title}，${request.payload.startDate} - ${request.payload.endDate}`;
  }
  if (request.type === "knowledge_document_create") {
    return `知识库新增文档：${request.payload.title}`;
  }
  if (request.type === "knowledge_document_update") {
    return `知识库编辑文档：${request.payload.title}`;
  }
  return request.type;
}

function eventEndDate(event) {
  if (event.allDay) {
    return addDays(eventDate(event.endAt), -1);
  }
  return eventDate(event.endAt);
}

function withinPeriod(date, period) {
  return date >= period.start && date < period.endExclusive;
}

function assignmentOverlapsPeriod(assignment, period) {
  return assignment.startDate < period.endExclusive && addDays(assignment.endDate, 1) > period.start;
}

function eachDateInRange(startDate, endExclusive) {
  const dates = [];
  let date = startDate;
  while (date < endExclusive) {
    dates.push(date);
    date = addDays(date, 1);
  }
  return dates;
}

function clampAssignmentToPeriod(assignment, period) {
  const start = assignment.startDate > period.start ? assignment.startDate : period.start;
  const endExclusive = addDays(assignment.endDate, 1) < period.endExclusive ? addDays(assignment.endDate, 1) : period.endExclusive;
  return { start, endExclusive };
}

function getProjectPeriod(state) {
  const dates = [];
  for (const assignment of state.assignments) {
    dates.push(assignment.startDate, assignment.endDate);
  }
  for (const milestone of state.milestones) {
    dates.push(milestone.date);
  }
  if (dates.length === 0) {
    const today = todayDate();
    return { start: today, endExclusive: addDays(today, 1), label: "整个项目" };
  }
  dates.sort();
  return { start: dates[0], endExclusive: addDays(dates[dates.length - 1], 1), label: "整个项目" };
}

function periodLabel(period) {
  return `${period.start} - ${addDays(period.endExclusive, -1)}`;
}

function taskScopeIds(state, period, rangeMode) {
  if (rangeMode === "project") {
    return new Set(state.tasks.map((task) => task.id));
  }
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const ids = new Set();
  const addTaskAndParents = (taskId) => {
    let task = tasksById.get(taskId);
    while (task) {
      ids.add(task.id);
      task = task.parentId ? tasksById.get(task.parentId) : null;
    }
  };
  for (const assignment of state.assignments) {
    if (assignmentOverlapsPeriod(assignment, period)) {
      addTaskAndParents(assignment.taskId);
    }
  }
  for (const milestone of state.milestones) {
    if (withinPeriod(milestone.date, period)) {
      addTaskAndParents(milestone.taskId);
    }
  }
  return ids;
}

function computeDashboard(state, period, rangeMode) {
  const dayCount = Math.max(1, daysBetween(period.start, period.endExclusive));
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const membersById = new Map(state.members.map((member) => [member.userId, member]));
  const scopedTaskIds = taskScopeIds(state, period, rangeMode);
  const scopedTasks = state.tasks.filter((task) => scopedTaskIds.has(task.id));
  const statusCounts = {
    todo: scopedTasks.filter((task) => task.status === "todo").length,
    doing: scopedTasks.filter((task) => task.status === "doing").length,
    done: scopedTasks.filter((task) => task.status === "done").length
  };

  const loadByMember = new Map(state.members.map((member) => [member.userId, {
    member,
    teamHours: 0,
    busyHours: 0,
    daily: new Map()
  }]));

  for (const assignment of state.assignments) {
    if (!assignmentOverlapsPeriod(assignment, period)) {
      continue;
    }
    const load = loadByMember.get(assignment.userId);
    if (!load) {
      continue;
    }
    const range = clampAssignmentToPeriod(assignment, period);
    for (const date of eachDateInRange(range.start, range.endExclusive)) {
      load.teamHours += dailyCapacityHours;
      load.daily.set(date, (load.daily.get(date) || 0) + dailyCapacityHours);
    }
  }

  for (const total of state.busyDailyTotals || []) {
    if (!withinPeriod(total.date, period)) {
      continue;
    }
    const load = loadByMember.get(total.userId);
    if (!load) {
      continue;
    }
    load.busyHours += total.hours;
    load.daily.set(total.date, (load.daily.get(total.date) || 0) + total.hours);
  }

  const memberLoads = [...loadByMember.values()].map((load) => {
    const totalHours = load.teamHours + load.busyHours;
    const overloadDays = [...load.daily.values()].filter((hours) => hours > dailyCapacityHours).length;
    return {
      ...load,
      totalHours,
      overloadDays,
      averageDaily: totalHours / dayCount,
      utilization: Math.min(100, (totalHours / (dayCount * dailyCapacityHours)) * 100)
    };
  }).sort((a, b) => b.totalHours - a.totalHours);

  const today = todayDate();
  const overdueAssignments = state.assignments
    .filter((assignment) => assignment.status !== "done" && assignment.endDate < today)
    .filter((assignment) => rangeMode === "project" || withinPeriod(assignment.endDate, period));
  const overdueMilestones = state.milestones
    .filter((milestone) => milestone.date < today && tasksById.get(milestone.taskId)?.status !== "done")
    .filter((milestone) => rangeMode === "project" || withinPeriod(milestone.date, period));
  const pendingRequests = state.requests.filter((request) => request.status === "pending");
  const overloadedMembers = memberLoads.filter((load) => load.overloadDays > 0);
  const rangeMilestones = state.milestones.filter((milestone) => withinPeriod(milestone.date, period)).slice(0, 8);
  const endingAssignments = state.assignments
    .filter((assignment) => withinPeriod(assignment.endDate, period))
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(0, 8);

  return {
    period,
    dayCount,
    tasks: scopedTasks,
    statusCounts,
    completionRate: scopedTasks.length ? Math.round((statusCounts.done / scopedTasks.length) * 100) : 0,
    memberLoads,
    overdueAssignments,
    overdueMilestones,
    pendingRequests,
    overloadedMembers,
    rangeMilestones,
    endingAssignments,
    tasksById,
    membersById
  };
}

export default function App() {
  const projectLoadRef = useRef(0);
  const knowledgeLoadRef = useRef(0);
  const [token, setToken] = useState(getStoredToken());
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [projectState, setProjectState] = useState(null);
  const [knowledgeState, setKnowledgeState] = useState(null);
  const [personalEvents, setPersonalEvents] = useState([]);
  const [mode, setMode] = useState("dashboard");
  const [dashboardScale, setDashboardScale] = useState("week");
  const [teamScale, setTeamScale] = useState("week");
  const [personalScale, setPersonalScale] = useState("day");
  const [selectedDate, setSelectedDate] = useState(todayDate());
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectModalOpen, setProjectModalOpen] = useState(false);

  const showError = useCallback((error) => {
    setNotice(normalizeError(error));
  }, []);

  const reloadProjects = useCallback(async (preferredProjectId = "") => {
    const data = await api("/api/projects");
    setProjects(data.projects);
    setProjectId((current) => chooseProjectId(data.projects, current, preferredProjectId));
    return data.projects;
  }, []);

  const reloadProject = useCallback(async (idToLoad) => {
    const loadId = ++projectLoadRef.current;
    if (!idToLoad) {
      setProjectState(null);
      return null;
    }
    const data = await api(`/api/projects/${idToLoad}`);
    if (projectLoadRef.current === loadId) {
      setProjectState(data);
    }
    return data;
  }, []);

  const reloadKnowledge = useCallback(async (idToLoad) => {
    const loadId = ++knowledgeLoadRef.current;
    if (!idToLoad) {
      setKnowledgeState(null);
      return null;
    }
    const data = await api(`/api/projects/${idToLoad}/knowledge`);
    if (knowledgeLoadRef.current === loadId) {
      setKnowledgeState(data);
    }
    return data;
  }, []);

  const reloadPersonal = useCallback(async () => {
    const data = await api("/api/personal/events");
    setPersonalEvents(data.events);
    return data.events;
  }, []);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const me = await api("/api/auth/me");
        if (!active) {
          return;
        }
        setUser(me.user);
        const list = await reloadProjects();
        await reloadPersonal();
        if (list[0]?.id) {
          await reloadProject(list[0].id);
        }
      } catch (error) {
        storeToken("");
        setToken("");
        showError(error);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    bootstrap();
    return () => {
      active = false;
    };
  }, [token, reloadProjects, reloadProject, reloadPersonal, showError]);

  useEffect(() => {
    if (token && projectId) {
      reloadProject(projectId).catch(showError);
    }
  }, [token, projectId, reloadProject, showError]);

  useEffect(() => {
    if (token && projectId && mode === "knowledge") {
      reloadKnowledge(projectId).catch(showError);
    }
  }, [token, projectId, mode, reloadKnowledge, showError]);

  useEffect(() => {
    if (!token || !projectId) {
      return undefined;
    }
    const socket = createSocket(projectId, (message) => {
      if (message.type === "project:update" && message.projectId === projectId) {
        reloadProject(projectId).catch(showError);
        reloadKnowledge(projectId).catch(showError);
        reloadProjects().catch(showError);
        reloadPersonal().catch(showError);
      }
      if (message.type === "personal:update") {
        reloadPersonal().catch(showError);
      }
    });
    return () => socket?.close();
  }, [token, projectId, reloadProject, reloadKnowledge, reloadProjects, reloadPersonal, showError]);

  const authenticated = async (payload) => {
    storeToken(payload.token);
    setToken(payload.token);
    setUser(payload.user);
    setNotice("");
  };

  const logout = () => {
    storeToken("");
    setToken("");
    setUser(null);
    setProjectState(null);
    setKnowledgeState(null);
    setPersonalEvents([]);
  };

  const mutateProject = async (path, options) => {
    const state = await api(path, options);
    setProjectState(state);
    await reloadProjects();
    await reloadPersonal();
    if (mode === "knowledge") {
      await reloadKnowledge(state.project.id);
    }
    return state;
  };

  const mutateKnowledge = async (path, options) => {
    const state = await api(path, options);
    setKnowledgeState(state);
    return state;
  };

  if (loading) {
    return <div className="boot">加载中</div>;
  }

  if (!token || !user) {
    return <AuthView onAuth={authenticated} notice={notice} setNotice={setNotice} />;
  }

  const activeProjectState = matchingProjectState(projectState, projectId);
  const activeKnowledgeState = knowledgeState?.projectId === projectId ? knowledgeState : null;

  return (
    <div className="app">
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-mark"><CalendarDays size={18} /></span>
          <div>
            <span>项目日程</span>
            <small>Team Planner</small>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="sidebar-heading">
            <span>项目</span>
            <button className="icon-button" onClick={() => setProjectModalOpen(true)} title="新建项目" aria-label="新建项目">
              <Plus size={16} />
            </button>
          </div>
          <div className="project-list">
            {projects.length === 0 && <div className="sidebar-empty">暂无项目</div>}
            {projects.map((project) => (
            <button
                key={project.id}
                type="button"
                className={project.id === projectId ? "project-item active" : "project-item"}
                onClick={() => {
                  if (project.id !== projectId) {
                    setProjectState(null);
                    setKnowledgeState(null);
                  }
                  setProjectId(project.id);
                }}
              >
                <span>{project.name}</span>
                <small>{project.role === "admin" ? "管理员" : "成员"}</small>
              </button>
            ))}
          </div>
        </section>

        {activeProjectState && (
          <section className="sidebar-section">
            <div className="sidebar-heading">
              <span>成员</span>
              <small>{activeProjectState.members.length}</small>
            </div>
            <div className="sidebar-members">
              {activeProjectState.members.slice(0, 8).map((member) => (
                <div className="sidebar-member" key={member.userId}>
                  <span className="swatch" style={{ background: member.color }} />
                  <span>{member.displayName}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="sidebar-footer">
          <span>{user.displayName}</span>
          <button className="icon-button" onClick={logout} title="退出登录" aria-label="退出登录">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <div className="topbar-title-line">
              <h1>{activeProjectState?.project.name || "项目日程"}</h1>
              {activeProjectState && (
                <button
                  className={mode === "knowledge" ? "knowledge-top-button active" : "knowledge-top-button"}
                  type="button"
                  onClick={() => setMode("knowledge")}
                >
                  <BookOpen size={16} />知识库
                </button>
              )}
            </div>
            <span>{mode === "dashboard" ? "仪表盘" : mode === "team" ? "团队模式" : mode === "knowledge" ? "知识库" : "个人模式"}</span>
          </div>
          <div className="topbar-controls">
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              aria-label="当前日期"
            />
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                ["dashboard", "仪表盘"],
                ["team", "团队模式"],
                ["personal", "个人模式"]
              ]}
            />
          </div>
        </header>

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="关闭"><X size={16} /></button>
          </div>
        )}

        {!projectId ? (
          <EmptyProject onOpenCreate={() => setProjectModalOpen(true)} />
        ) : !activeProjectState ? (
          <ProjectLoading />
        ) : mode === "dashboard" ? (
          <DashboardMode
            state={activeProjectState}
            scale={dashboardScale}
            setScale={setDashboardScale}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
          />
        ) : mode === "team" ? (
          <TeamMode
            state={activeProjectState}
            scale={teamScale}
            setScale={setTeamScale}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            mutateProject={mutateProject}
            showError={showError}
          />
        ) : mode === "knowledge" ? (
          <KnowledgeMode
            state={activeProjectState}
            knowledge={activeKnowledgeState}
            mutateKnowledge={mutateKnowledge}
            mutateProject={mutateProject}
            showError={showError}
          />
        ) : (
          <PersonalMode
            projects={projects}
            state={activeProjectState}
            projectId={projectId}
            events={personalEvents}
            scale={personalScale}
            setScale={setPersonalScale}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            reloadPersonal={reloadPersonal}
            reloadProject={reloadProject}
            showError={showError}
          />
        )}
      </div>

      {projectModalOpen && (
        <ProjectCreateModal
          onClose={() => setProjectModalOpen(false)}
          onCreate={async (name) => {
          try {
            const state = await api("/api/projects", { method: "POST", body: { name, timezone: "Asia/Shanghai" } });
            await reloadProjects(state.project.id);
            setProjectId(state.project.id);
            setProjectState(state);
            setKnowledgeState(null);
            setProjectModalOpen(false);
          } catch (error) {
            showError(error);
          }
        }}
        />
      )}
    </div>
  );
}

function AuthView({ onAuth, notice, setNotice }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", password: "", displayName: "", registrationCode: "" });
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const payload = mode === "login"
        ? await api("/api/auth/login", { method: "POST", body: form })
        : await api("/api/auth/register", { method: "POST", body: form });
      await onAuth(payload);
    } catch (error) {
      setNotice(normalizeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <h1>项目日程</h1>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            ["login", "登录"],
            ["register", "注册"]
          ]}
        />
        <label>
          用户名
          <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="username" />
        </label>
        {mode === "register" && (
          <label>
            显示名
            <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
          </label>
        )}
        {mode === "register" && (
          <label>
            注册码
            <input value={form.registrationCode} onChange={(event) => setForm({ ...form, registrationCode: event.target.value })} autoComplete="one-time-code" />
          </label>
        )}
        <label>
          密码
          <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {notice && <div className="inline-error">{notice}</div>}
        <button className="primary-button" disabled={busy}>
          <Save size={17} />
          {mode === "login" ? "登录" : "注册"}
        </button>
      </form>
    </main>
  );
}

function EmptyProject({ onOpenCreate }) {
  return (
    <main className="empty-state">
      <div>
        <h2>还没有项目</h2>
        <p>创建第一个项目后，就可以开始查看仪表盘、甘特图和成员负载。</p>
        <button className="primary-button" onClick={onOpenCreate}><FolderPlus size={17} />新建项目</button>
      </div>
    </main>
  );
}

function ProjectLoading() {
  return (
    <main className="empty-state">
      <div>
        <h2>正在切换项目</h2>
        <p>正在加载所选项目内容。</p>
      </div>
    </main>
  );
}

function ProjectCreateModal({ onCreate, onClose }) {
  const [name, setName] = useState("");
  return (
    <Modal title="新建项目" onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) {
          onCreate(name.trim());
        }
      }}>
        <div className="stack-form">
          <label>
            项目名称
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：产品发布计划" autoFocus />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>取消</button>
            <button className="primary-button"><FolderPlus size={17} />创建</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map(([key, label]) => (
        <button key={key} type="button" className={value === key ? "active" : ""} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function DateStepper({ scale, selectedDate, setSelectedDate }) {
  return (
    <div className="date-stepper">
      <button type="button" onClick={() => setSelectedDate(shiftSelectedDate(scale, selectedDate, -1))} title="上一段" aria-label="上一段">
        <ChevronLeft size={17} />
      </button>
      <button type="button" onClick={() => setSelectedDate(todayDate())}>今天</button>
      <button type="button" onClick={() => setSelectedDate(shiftSelectedDate(scale, selectedDate, 1))} title="下一段" aria-label="下一段">
        <ChevronRight size={17} />
      </button>
    </div>
  );
}

function DashboardMode({ state, scale, setScale, selectedDate, setSelectedDate }) {
  const [rangeMode, setRangeMode] = useState("current");
  const period = useMemo(() => rangeMode === "current" ? getPeriod(scale, selectedDate) : getProjectPeriod(state), [rangeMode, scale, selectedDate, state]);
  const dashboard = useMemo(() => computeDashboard(state, period, rangeMode), [state, period, rangeMode]);
  const totalRiskCount = dashboard.overdueAssignments.length + dashboard.overdueMilestones.length + dashboard.overloadedMembers.length + dashboard.pendingRequests.length;

  return (
    <main className="workspace dashboard-workspace">
      <div className="workspace-toolbar">
        <div className="toolbar-title">
          <h2>{state.project.name}</h2>
          <span>仪表盘 · {periodLabel(period)}</span>
        </div>
        <Segmented
          value={rangeMode}
          onChange={setRangeMode}
          options={[
            ["current", "当前周期"],
            ["project", "整个项目"]
          ]}
        />
        {rangeMode === "current" && (
          <>
            <Segmented
              value={scale}
              onChange={setScale}
              options={[
                ["week", "一周"],
                ["month", "一月"],
                ["year", "一年"]
              ]}
            />
            <DateStepper scale={scale} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
          </>
        )}
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel span-2">
          <div className="panel-heading">
            <h3>项目进度</h3>
            <small>{dashboard.tasks.length} 个范围内任务</small>
          </div>
          <div className="metric-grid">
            <MetricCard label="完成率" value={`${dashboard.completionRate}%`} tone="green" />
            <MetricCard label="待办" value={dashboard.statusCounts.todo} />
            <MetricCard label="进行中" value={dashboard.statusCounts.doing} tone="amber" />
            <MetricCard label="已完成" value={dashboard.statusCounts.done} tone="green" />
          </div>
          <div className="progress-strip" aria-label="任务完成率">
            <span style={{ width: `${dashboard.completionRate}%` }} />
          </div>
          <div className="status-summary">
            <span><i className="status-dot todo" />待办 {dashboard.statusCounts.todo}</span>
            <span><i className="status-dot doing" />进行中 {dashboard.statusCounts.doing}</span>
            <span><i className="status-dot done" />完成 {dashboard.statusCounts.done}</span>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-heading">
            <h3>风险</h3>
            <small>{totalRiskCount} 项</small>
          </div>
          <div className="risk-stack">
            <RiskRow label="逾期任务" value={dashboard.overdueAssignments.length} danger={dashboard.overdueAssignments.length > 0} />
            <RiskRow label="逾期里程碑" value={dashboard.overdueMilestones.length} danger={dashboard.overdueMilestones.length > 0} />
            <RiskRow label="过载成员" value={dashboard.overloadedMembers.length} danger={dashboard.overloadedMembers.length > 0} />
            <RiskRow label="待审批" value={dashboard.pendingRequests.length} danger={dashboard.pendingRequests.length > 0} />
          </div>
        </section>

        <section className="dashboard-panel span-3">
          <div className="panel-heading">
            <h3>成员负载</h3>
            <small>每日容量 {dailyCapacityHours} 小时 · {dashboard.dayCount} 天</small>
          </div>
          <div className="load-list">
            {dashboard.memberLoads.map((load) => (
              <div className={`load-row ${load.overloadDays > 0 ? "overload" : ""}`} key={load.member.userId}>
                <div className="load-person">
                  <span className="swatch" style={{ background: load.member.color }} />
                  <div>
                    <strong>{load.member.displayName}</strong>
                    <small>@{load.member.username}</small>
                  </div>
                </div>
                <div className="load-meter">
                  <span style={{ width: `${load.utilization}%`, background: load.overloadDays > 0 ? "#d92d20" : load.member.color }} />
                </div>
                <div className="load-numbers">
                  <span>{Math.round(load.totalHours * 10) / 10}h</span>
                  <small>团队 {Math.round(load.teamHours * 10) / 10}h · 忙闲 {Math.round(load.busyHours * 10) / 10}h</small>
                  <small>日均 {Math.round(load.averageDaily * 10) / 10}h · 过载 {load.overloadDays} 天</small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-heading">
            <h3>近期里程碑</h3>
            <small>{dashboard.rangeMilestones.length} 项</small>
          </div>
          <CompactList
            empty="当前范围暂无里程碑"
            items={dashboard.rangeMilestones.map((milestone) => ({
              key: milestone.id,
              color: milestone.color,
              title: milestone.title,
              meta: `${dashboard.tasksById.get(milestone.taskId)?.title || "任务"} · ${milestone.date}`
            }))}
          />
        </section>

        <section className="dashboard-panel">
          <div className="panel-heading">
            <h3>即将结束</h3>
            <small>{dashboard.endingAssignments.length} 项</small>
          </div>
          <CompactList
            empty="当前范围暂无结束任务"
            items={dashboard.endingAssignments.map((assignment) => ({
              key: assignment.id,
              color: dashboard.membersById.get(assignment.userId)?.color || "#697386",
              title: dashboard.tasksById.get(assignment.taskId)?.title || "任务",
              meta: `${assignment.displayName} · ${assignment.endDate} · ${statusLabels[assignment.status]}`
            }))}
          />
        </section>

        <section className="dashboard-panel">
          <div className="panel-heading">
            <h3>待审批</h3>
            <small>{dashboard.pendingRequests.length} 项</small>
          </div>
          <CompactList
            empty="暂无待审批请求"
            items={dashboard.pendingRequests.slice(0, 8).map((request) => ({
              key: request.id,
              color: "#8b5cf6",
              title: request.requesterDisplayName,
              meta: formatRequest(request)
            }))}
          />
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, tone = "blue" }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RiskRow({ label, value, danger }) {
  return (
    <div className={danger ? "risk-row danger" : "risk-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CompactList({ items, empty }) {
  if (items.length === 0) {
    return <div className="empty-line">{empty}</div>;
  }
  return (
    <div className="compact-list">
      {items.map((item) => (
        <div className="compact-item" key={item.key}>
          <span className="swatch" style={{ background: item.color }} />
          <div>
            <strong>{item.title}</strong>
            <small>{item.meta}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function MarkdownPreview({ content }) {
  const blocks = [];
  const lines = String(content || "").split(/\r?\n/);
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(<p key={`p-${blocks.length}`}>{paragraph.join(" ")}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {list.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      );
      list = [];
    }
  };
  const flushCode = () => {
    blocks.push(
      <pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>
    );
    code = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        flushCode();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const Tag = `h${heading[1].length + 1}`;
      blocks.push(<Tag key={`h-${blocks.length}`}>{heading[2]}</Tag>);
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (inCode) {
    flushCode();
  }
  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    return <div className="empty-line">暂无正文</div>;
  }
  return <article className="markdown-preview">{blocks}</article>;
}

function KnowledgeMode({ state, knowledge, mutateKnowledge, mutateProject, showError }) {
  const isAdmin = state.currentMember.role === "admin";
  const categories = knowledge?.categories || [];
  const documents = knowledge?.documents || [];
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [activeModal, setActiveModal] = useState(null);
  const [categoryForm, setCategoryForm] = useState({ id: "", name: "" });
  const [documentForm, setDocumentForm] = useState({ documentId: "", title: "", categoryId: "", content: "" });

  useEffect(() => {
    if (documents.length === 0 && selectedDocumentId) {
      setSelectedDocumentId("");
      return;
    }
    if (documents.length > 0 && !documents.some((document) => document.id === selectedDocumentId)) {
      setSelectedDocumentId(documents[0].id);
    }
  }, [documents, selectedDocumentId]);

  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) || documents[0] || null;
  const uncategorizedDocuments = documents.filter((document) => !document.categoryId);

  const openCategoryModal = (category = null) => {
    setCategoryForm({ id: category?.id || "", name: category?.name || "" });
    setActiveModal(category ? "renameCategory" : "category");
  };

  const openDocumentModal = (modal, document = null) => {
    setDocumentForm({
      documentId: document?.id || "",
      title: document?.title || "",
      categoryId: document?.categoryId || "",
      content: document?.content || ""
    });
    setActiveModal(modal);
  };

  const submitCategory = async (event) => {
    event.preventDefault();
    try {
      if (activeModal === "renameCategory") {
        await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/categories/${categoryForm.id}`, {
          method: "PATCH",
          body: { name: categoryForm.name }
        });
      } else {
        await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/categories`, {
          method: "POST",
          body: { name: categoryForm.name }
        });
      }
      setActiveModal(null);
    } catch (error) {
      showError(error);
    }
  };

  const submitDocument = async (event) => {
    event.preventDefault();
    const body = {
      title: documentForm.title,
      categoryId: documentForm.categoryId || null,
      content: documentForm.content
    };
    try {
      if (activeModal === "document") {
        const next = await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/documents`, { method: "POST", body });
        setSelectedDocumentId(next.documents[0]?.id || "");
      } else if (activeModal === "editDocument") {
        await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/documents/${documentForm.documentId}`, { method: "PATCH", body });
        setSelectedDocumentId(documentForm.documentId);
      } else if (activeModal === "requestCreate") {
        await mutateProject(`/api/projects/${state.project.id}/requests`, {
          method: "POST",
          body: { type: "knowledge_document_create", ...body }
        });
      } else if (activeModal === "requestUpdate") {
        await mutateProject(`/api/projects/${state.project.id}/requests`, {
          method: "POST",
          body: { type: "knowledge_document_update", documentId: documentForm.documentId, ...body }
        });
      }
      setActiveModal(null);
    } catch (error) {
      showError(error);
    }
  };

  if (!knowledge) {
    return <ProjectLoading />;
  }

  return (
    <main className="workspace">
      <div className="workspace-toolbar">
        <div className="toolbar-title">
          <h2>知识库</h2>
          <span>{state.project.name} · {documents.length} 篇文档</span>
        </div>
        {isAdmin ? (
          <>
            <button type="button" onClick={() => openCategoryModal()}><Folder size={16} />新增分类</button>
            <button type="button" onClick={() => openDocumentModal("document")}><Plus size={16} />新增文档</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => openDocumentModal("requestCreate")}><Plus size={16} />申请新增</button>
            <button type="button" disabled={!selectedDocument} onClick={() => openDocumentModal("requestUpdate", selectedDocument)}><Pencil size={16} />申请编辑</button>
          </>
        )}
      </div>

      <div className="knowledge-layout">
        <aside className="knowledge-sidebar">
          <div className="panel-heading compact-heading">
            <h3><BookOpen size={17} />目录</h3>
            <small>{categories.length} 类</small>
          </div>
          <div className="knowledge-category-list">
            {categories.map((category) => (
              <div className="knowledge-category" key={category.id}>
                <div className="knowledge-category-heading">
                  <span><Folder size={15} />{category.name}</span>
                  {isAdmin && (
                    <div className="row-actions">
                      <button className="icon-button" type="button" title="重命名分类" aria-label="重命名分类" onClick={() => openCategoryModal(category)}>
                        <Pencil size={14} />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="删除分类"
                        aria-label="删除分类"
                        onClick={async () => {
                          if (!window.confirm("删除分类后，分类下文档会转为未分类。")) {
                            return;
                          }
                          try {
                            await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/categories/${category.id}`, { method: "DELETE" });
                          } catch (error) {
                            showError(error);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <KnowledgeDocumentList
                  documents={documents.filter((document) => document.categoryId === category.id)}
                  selectedDocument={selectedDocument}
                  onSelect={setSelectedDocumentId}
                />
              </div>
            ))}
            {(uncategorizedDocuments.length > 0 || categories.length === 0) && (
              <div className="knowledge-category">
                <div className="knowledge-category-heading">
                  <span><Folder size={15} />未分类</span>
                </div>
                <KnowledgeDocumentList documents={uncategorizedDocuments} selectedDocument={selectedDocument} onSelect={setSelectedDocumentId} />
              </div>
            )}
          </div>
        </aside>

        <section className="main-panel knowledge-reader">
          {selectedDocument ? (
            <>
              <header className="knowledge-doc-header">
                <div>
                  <h2>{selectedDocument.title}</h2>
                  <small>更新于 {selectedDocument.updatedAt?.slice(0, 10)} · {selectedDocument.updatedByName || "成员"}</small>
                </div>
                <div className="row-actions">
                  {isAdmin ? (
                    <>
                      <button type="button" onClick={() => openDocumentModal("editDocument", selectedDocument)}><Pencil size={16} />编辑</button>
                      <button
                        type="button"
                        className="danger"
                        onClick={async () => {
                          if (!window.confirm("确定删除这篇知识库文档吗？")) {
                            return;
                          }
                          try {
                            await mutateKnowledge(`/api/projects/${state.project.id}/knowledge/documents/${selectedDocument.id}`, { method: "DELETE" });
                            setSelectedDocumentId("");
                          } catch (error) {
                            showError(error);
                          }
                        }}
                      >
                        <Trash2 size={16} />删除
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => openDocumentModal("requestUpdate", selectedDocument)}><Pencil size={16} />申请编辑</button>
                  )}
                </div>
              </header>
              <MarkdownPreview content={selectedDocument.content} />
            </>
          ) : (
            <div className="knowledge-empty">
              <BookOpen size={30} />
              <h2>暂无知识库文档</h2>
              <p>{isAdmin ? "创建第一篇文档后，团队成员就可以在这里查看项目资料。" : "你可以提交新增文档申请，等待管理员审批。"}</p>
            </div>
          )}
        </section>

        <aside className="side-panel insight-rail">
          <section>
            <h3>文档信息</h3>
            {selectedDocument ? (
              <div className="knowledge-meta">
                <span>创建者</span>
                <strong>{selectedDocument.createdByName || "成员"}</strong>
                <span>最近更新</span>
                <strong>{selectedDocument.updatedAt?.replace("T", " ").slice(0, 16)}</strong>
              </div>
            ) : (
              <div className="empty-line">暂无选中文档</div>
            )}
          </section>
          <RequestsPanel state={state} isAdmin={isAdmin} mutateProject={mutateProject} showError={showError} />
        </aside>
      </div>

      {(activeModal === "category" || activeModal === "renameCategory") && (
        <Modal title={activeModal === "renameCategory" ? "重命名分类" : "新增分类"} onClose={() => setActiveModal(null)}>
          <form className="stack-form" onSubmit={submitCategory}>
            <label>
              分类名称
              <input value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} autoFocus />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setActiveModal(null)}>取消</button>
              <button className="primary-button"><Save size={16} />保存</button>
            </div>
          </form>
        </Modal>
      )}

      {(activeModal === "document" || activeModal === "editDocument" || activeModal === "requestCreate" || activeModal === "requestUpdate") && (
        <Modal
          title={activeModal === "document" ? "新增文档" : activeModal === "editDocument" ? "编辑文档" : activeModal === "requestCreate" ? "申请新增文档" : "申请编辑文档"}
          onClose={() => setActiveModal(null)}
        >
          <KnowledgeDocumentForm
            form={documentForm}
            setForm={setDocumentForm}
            categories={categories}
            onSubmit={submitDocument}
            submitLabel={activeModal === "requestCreate" || activeModal === "requestUpdate" ? "提交审批" : "保存"}
            onCancel={() => setActiveModal(null)}
          />
        </Modal>
      )}
    </main>
  );
}

function KnowledgeDocumentList({ documents, selectedDocument, onSelect }) {
  if (documents.length === 0) {
    return <div className="knowledge-doc-empty">暂无文档</div>;
  }
  return (
    <div className="knowledge-doc-list">
      {documents.map((document) => (
        <button
          key={document.id}
          type="button"
          className={selectedDocument?.id === document.id ? "knowledge-doc-item active" : "knowledge-doc-item"}
          onClick={() => onSelect(document.id)}
        >
          <FileText size={15} />
          <span>{document.title}</span>
        </button>
      ))}
    </div>
  );
}

function KnowledgeDocumentForm({ form, setForm, categories, onSubmit, submitLabel, onCancel }) {
  return (
    <form className="stack-form" onSubmit={onSubmit}>
      <label>
        标题
        <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} autoFocus />
      </label>
      <label>
        分类
        <select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
          <option value="">未分类</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
      <label>
        Markdown 正文
        <textarea
          className="knowledge-editor"
          value={form.content}
          onChange={(event) => setForm({ ...form, content: event.target.value })}
          placeholder="# 标题&#10;- 要点"
        />
      </label>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>取消</button>
        <button className="primary-button"><Save size={16} />{submitLabel}</button>
      </div>
    </form>
  );
}

function TeamMode({ state, scale, setScale, selectedDate, setSelectedDate, mutateProject, showError }) {
  const isAdmin = state.currentMember.role === "admin";
  const [showPersonalBusy, setShowPersonalBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="workspace">
      <div className="workspace-toolbar">
        <div className="toolbar-title">
          <h2>{state.project.name}</h2>
          <span>{state.project.timezone}</span>
        </div>
        <Segmented
          value={scale}
          onChange={setScale}
          options={[
            ["week", "一周"],
            ["month", "一月"],
            ["year", "一年"]
          ]}
        />
        {isAdmin && (
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showPersonalBusy}
              onChange={(event) => setShowPersonalBusy(event.target.checked)}
            />
            <span />
            显示个人日程
          </label>
        )}
        {isAdmin && (
          <button onClick={() => setSettingsOpen(true)}><Settings size={16} />项目设置</button>
        )}
        <DateStepper scale={scale} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
      </div>

      <div className="work-layout">
        <section className="main-panel">
          <TeamGantt
            state={state}
            scale={scale}
            selectedDate={selectedDate}
            isAdmin={isAdmin}
            showPersonalBusy={isAdmin && showPersonalBusy}
            mutateProject={mutateProject}
            showError={showError}
          />
        </section>

        <aside className="side-panel insight-rail">
          <TeamForms state={state} isAdmin={isAdmin} mutateProject={mutateProject} showError={showError} />
          <MembersPanel state={state} isAdmin={isAdmin} mutateProject={mutateProject} showError={showError} />
          <RequestsPanel state={state} isAdmin={isAdmin} mutateProject={mutateProject} showError={showError} />
          {isAdmin && <BusyPanel state={state} />}
        </aside>
      </div>
      {settingsOpen && (
        <ProjectSettingsModal
          state={state}
          mutateProject={mutateProject}
          showError={showError}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}

function ProjectSettingsModal({ state, mutateProject, showError, onClose }) {
  const [name, setName] = useState(state.project.name);

  return (
    <Modal title="项目设置" onClose={onClose}>
      <form className="stack-form" onSubmit={async (event) => {
        event.preventDefault();
        try {
          await mutateProject(`/api/projects/${state.project.id}`, {
            method: "PATCH",
            body: { name, timezone: state.project.timezone }
          });
          onClose();
        } catch (error) {
          showError(error);
        }
      }}>
        <label>
          项目名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          项目时区
          <input value={state.project.timezone} readOnly />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button className="primary-button"><Save size={16} />保存</button>
        </div>
      </form>
    </Modal>
  );
}

function MembersPanel({ state, isAdmin, mutateProject, showError }) {
  const [memberForm, setMemberForm] = useState({ username: "" });
  const [memberModalOpen, setMemberModalOpen] = useState(false);

  return (
    <section>
      <div className="panel-heading compact-heading">
        <h3><Users size={17} />成员</h3>
        {isAdmin && <button onClick={() => setMemberModalOpen(true)}><Plus size={16} />新增</button>}
      </div>
      <div className="member-list">
        {state.members.map((member) => (
          <div className="member-row" key={member.userId}>
            <span className="swatch" style={{ background: member.color }} />
            <div>
              <strong>{member.displayName}</strong>
              <small>@{member.username} · {member.role === "admin" ? "管理员" : "成员"}</small>
            </div>
            {isAdmin && (
              <div className="row-actions">
                {member.role === "member" && (
                  <button
                    title="设为管理员"
                    onClick={async () => {
                      try {
                        await mutateProject(`/api/projects/${state.project.id}/members/${member.userId}`, {
                          method: "PATCH",
                          body: { role: "admin" }
                        });
                      } catch (error) {
                        showError(error);
                      }
                    }}
                  >
                    设为管理员
                  </button>
                )}
                <button
                  className="icon-button danger"
                  title="移除成员"
                  aria-label="移除成员"
                  onClick={async () => {
                    try {
                      await mutateProject(`/api/projects/${state.project.id}/members/${member.userId}`, { method: "DELETE" });
                    } catch (error) {
                      showError(error);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {memberModalOpen && (
        <Modal title="新增成员" onClose={() => setMemberModalOpen(false)}>
          <form className="stack-form" onSubmit={async (event) => {
            event.preventDefault();
            try {
              await mutateProject(`/api/projects/${state.project.id}/members`, { method: "POST", body: memberForm });
              setMemberForm({ username: "" });
              setMemberModalOpen(false);
            } catch (error) {
              showError(error);
            }
          }}>
            <label>
              用户名
              <input value={memberForm.username} onChange={(event) => setMemberForm({ ...memberForm, username: event.target.value })} placeholder="已注册用户名" autoFocus />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setMemberModalOpen(false)}>取消</button>
              <button className="primary-button"><Plus size={16} />添加成员</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function TeamForms({ state, isAdmin, mutateProject, showError }) {
  const today = todayDate();
  const [taskForm, setTaskForm] = useState({ title: "", description: "", parentId: "", status: "todo" });
  const [assignmentForm, setAssignmentForm] = useState(emptyAssignmentForm(today));
  const [milestoneForm, setMilestoneForm] = useState({ taskId: "", date: today, title: "", color: "#e11d48" });
  const [requestForm, setRequestForm] = useState({ assignmentId: "", startDate: today, endDate: today, status: "doing" });
  const [activeModal, setActiveModal] = useState(null);

  useEffect(() => {
    if (!assignmentForm.taskId && state.tasks[0]) {
      setAssignmentForm((current) => ({ ...current, taskId: state.tasks[0].id }));
    }
    if (!assignmentForm.userId && state.members[0]) {
      setAssignmentForm((current) => ({ ...current, userId: state.members[0].userId }));
    }
    if (!milestoneForm.taskId && state.tasks[0]) {
      setMilestoneForm((current) => ({ ...current, taskId: state.tasks[0].id }));
    }
  }, [state.tasks, state.members, assignmentForm.taskId, assignmentForm.userId, milestoneForm.taskId]);

  const myAssignments = state.assignments.filter((assignment) => assignment.userId === state.currentMember.userId);

  return (
    <section>
      <h3>快速操作</h3>
      {isAdmin ? (
        <div className="action-grid">
          <button onClick={() => setActiveModal("task")}><Plus size={16} />新增任务</button>
          <button onClick={() => setActiveModal("assignment")}><Plus size={16} />新增分配</button>
          <button onClick={() => setActiveModal("milestone")}><Plus size={16} />新增标志</button>
        </div>
      ) : (
        <div className="action-grid">
          <button onClick={() => setActiveModal("request")}><Plus size={16} />提交变更申请</button>
        </div>
      )}

      {activeModal === "task" && (
        <Modal title="新增任务" onClose={() => setActiveModal(null)}>
            <form className="stack-form" onSubmit={async (event) => {
              event.preventDefault();
              try {
                await mutateProject(`/api/projects/${state.project.id}/tasks`, {
                  method: "POST",
                  body: { ...taskForm, parentId: taskForm.parentId || null }
                });
                setTaskForm({ title: "", description: "", parentId: "", status: "todo" });
                setActiveModal(null);
              } catch (error) {
                showError(error);
              }
            }}>
              <label>
                任务名称
                <input value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} placeholder="任务名称" autoFocus />
              </label>
              <label>
                描述
                <textarea value={taskForm.description} onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })} placeholder="描述" />
              </label>
              <label>
                父任务
              <select value={taskForm.parentId} onChange={(event) => setTaskForm({ ...taskForm, parentId: event.target.value })}>
                <option value="">顶层任务</option>
                {state.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
              </label>
              <label>
                状态
              <select value={taskForm.status} onChange={(event) => setTaskForm({ ...taskForm, status: event.target.value })}>
                {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setActiveModal(null)}>取消</button>
                <button className="primary-button"><Plus size={16} />添加任务</button>
              </div>
            </form>
        </Modal>
      )}

      {activeModal === "assignment" && (
        <Modal title="新增分配" onClose={() => setActiveModal(null)}>
            <form className="stack-form" onSubmit={async (event) => {
              event.preventDefault();
              try {
                await mutateProject(`/api/projects/${state.project.id}/assignments`, { method: "POST", body: assignmentForm });
                setAssignmentForm(emptyAssignmentForm(todayDate()));
                setActiveModal(null);
              } catch (error) {
                showError(error);
              }
            }}>
              <label>
                任务
              <select value={assignmentForm.taskId} onChange={(event) => setAssignmentForm({ ...assignmentForm, taskId: event.target.value })}>
                {state.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
              </label>
              <label>
                成员
              <select value={assignmentForm.userId} onChange={(event) => setAssignmentForm({ ...assignmentForm, userId: event.target.value })}>
                {state.members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
              </select>
              </label>
              <div className="form-grid">
                <label>
                  开始
                  <input type="date" value={assignmentForm.startDate} onChange={(event) => setAssignmentForm({ ...assignmentForm, startDate: event.target.value })} />
                </label>
                <label>
                  结束
                  <input type="date" value={assignmentForm.endDate} onChange={(event) => setAssignmentForm({ ...assignmentForm, endDate: event.target.value })} />
                </label>
              </div>
              <label>
                状态
              <select value={assignmentForm.status} onChange={(event) => setAssignmentForm({ ...assignmentForm, status: event.target.value })}>
                {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setActiveModal(null)}>取消</button>
                <button className="primary-button"><Plus size={16} />添加分配</button>
              </div>
            </form>
        </Modal>
      )}

      {activeModal === "milestone" && (
        <Modal title="新增里程碑" onClose={() => setActiveModal(null)}>
            <form className="stack-form" onSubmit={async (event) => {
              event.preventDefault();
              try {
                await mutateProject(`/api/projects/${state.project.id}/milestones`, { method: "POST", body: milestoneForm });
                setMilestoneForm({ taskId: state.tasks[0]?.id || "", date: todayDate(), title: "", color: "#e11d48" });
                setActiveModal(null);
              } catch (error) {
                showError(error);
              }
            }}>
              <label>
                任务
              <select value={milestoneForm.taskId} onChange={(event) => setMilestoneForm({ ...milestoneForm, taskId: event.target.value })}>
                {state.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
              </label>
              <label>
                日期
                <input type="date" value={milestoneForm.date} onChange={(event) => setMilestoneForm({ ...milestoneForm, date: event.target.value })} />
              </label>
              <label>
                标志文字
                <input value={milestoneForm.title} onChange={(event) => setMilestoneForm({ ...milestoneForm, title: event.target.value })} placeholder="标志文字" />
              </label>
              <label>
                颜色
                <input type="color" value={milestoneForm.color} onChange={(event) => setMilestoneForm({ ...milestoneForm, color: event.target.value })} />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setActiveModal(null)}>取消</button>
                <button className="primary-button"><Plus size={16} />添加标志</button>
              </div>
            </form>
        </Modal>
      )}

      {activeModal === "request" && (
        <Modal title="提交变更申请" onClose={() => setActiveModal(null)}>
          <form className="stack-form" onSubmit={async (event) => {
            event.preventDefault();
            try {
              await mutateProject(`/api/projects/${state.project.id}/requests`, {
                method: "POST",
                body: { type: "assignment_update", ...requestForm }
              });
              setActiveModal(null);
            } catch (error) {
              showError(error);
            }
          }}>
            <label>
              我的任务
            <select value={requestForm.assignmentId} onChange={(event) => setRequestForm({ ...requestForm, assignmentId: event.target.value })}>
              <option value="">选择我的任务</option>
              {myAssignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.displayName} · {assignment.startDate}</option>)}
            </select>
            </label>
            <div className="form-grid">
              <label>
                开始
                <input type="date" value={requestForm.startDate} onChange={(event) => setRequestForm({ ...requestForm, startDate: event.target.value })} />
              </label>
              <label>
                结束
                <input type="date" value={requestForm.endDate} onChange={(event) => setRequestForm({ ...requestForm, endDate: event.target.value })} />
              </label>
            </div>
            <label>
              状态
            <select value={requestForm.status} onChange={(event) => setRequestForm({ ...requestForm, status: event.target.value })}>
              {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setActiveModal(null)}>取消</button>
              <button className="primary-button"><Plus size={16} />提交申请</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function TeamGantt({ state, scale, selectedDate, isAdmin, showPersonalBusy, mutateProject, showError }) {
  const [expanded, setExpanded] = useState({});
  const [drag, setDrag] = useState(null);
  const gridRef = useRef(null);
  const period = useMemo(() => getPeriod(scale, selectedDate), [scale, selectedDate]);
  const rows = useMemo(() => {
    const teamRows = flattenRows(state.tasks, state.assignments, expanded);
    if (!showPersonalBusy) {
      return teamRows;
    }
    const members = new Map(state.members.map((member) => [member.userId, member]));
    const busyRows = state.busySlots.map((slot, index) => ({
      type: "busy",
      slot,
      member: members.get(slot.userId),
      depth: 0,
      key: `busy-${slot.userId}-${slot.startAt}-${index}`
    }));
    return [...teamRows, ...busyRows];
  }, [state.tasks, state.assignments, state.busySlots, state.members, expanded, showPersonalBusy]);
  const totalDays = daysBetween(period.start, period.endExclusive);
  const milestonesByTask = useMemo(() => {
    const map = new Map();
    for (const milestone of state.milestones) {
      map.set(milestone.taskId, [...(map.get(milestone.taskId) || []), milestone]);
    }
    return map;
  }, [state.milestones]);

  const patchAssignment = useCallback(async (assignment, patch) => {
    await mutateProject(`/api/projects/${state.project.id}/assignments/${assignment.id}`, {
      method: "PATCH",
      body: { ...assignment, ...patch }
    });
  }, [mutateProject, state.project.id]);

  useEffect(() => {
    if (!drag) {
      return undefined;
    }
    const calculate = (clientX) => {
      const rect = gridRef.current.getBoundingClientRect();
      const deltaDays = Math.round(((clientX - drag.startX) / rect.width) * totalDays);
      let startDate = drag.initialStart;
      let endDate = drag.initialEnd;
      if (drag.mode === "move") {
        startDate = addDays(drag.initialStart, deltaDays);
        endDate = addDays(drag.initialEnd, deltaDays);
      }
      if (drag.mode === "start") {
        startDate = addDays(drag.initialStart, deltaDays);
        if (startDate > endDate) {
          startDate = endDate;
        }
      }
      if (drag.mode === "end") {
        endDate = addDays(drag.initialEnd, deltaDays);
        if (endDate < startDate) {
          endDate = startDate;
        }
      }
      return { startDate, endDate };
    };
    const update = (clientX) => {
      const preview = calculate(clientX);
      setDrag((current) => current ? { ...current, preview } : null);
    };
    const move = (event) => update(event.clientX);
    const up = async (event) => {
      const latest = calculate(event.clientX);
      setDrag(null);
      if (latest.startDate !== drag.initialStart || latest.endDate !== drag.initialEnd) {
        try {
          await patchAssignment(drag.assignment, latest);
        } catch (error) {
          showError(error);
        }
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, patchAssignment, showError, totalDays]);

  return (
    <div className="gantt-shell">
      <div className="gantt-header">
        <div className="gantt-left header-cell">任务</div>
        <div className="gantt-timeline header-grid" style={{ gridTemplateColumns: period.cells.map((cell) => `${cell.days}fr`).join(" ") }}>
          {period.cells.map((cell) => (
            <div className="time-cell" key={cell.key}>
              <strong>{cell.label}</strong>
              {cell.subLabel && <small>周{cell.subLabel}</small>}
            </div>
          ))}
        </div>
      </div>
      <div className="gantt-body" ref={gridRef}>
        {rows.length === 0 && <div className="empty-line">暂无任务</div>}
        {rows.map((row) => (
          <div className={`gantt-row ${row.type}`} key={row.key || `${row.type}-${row.task?.id || row.assignment.id}`}>
            <div className="gantt-left row-label" style={{ paddingLeft: 12 + row.depth * 18 }}>
              {row.type === "task" ? (
                <>
                  <button
                    className="tree-toggle"
                    onClick={() => setExpanded({ ...expanded, [row.task.id]: expanded[row.task.id] === false })}
                    aria-label="展开折叠"
                    title="展开折叠"
                  >
                    {row.hasChildren || state.assignments.some((assignment) => assignment.taskId === row.task.id)
                      ? expanded[row.task.id] === false ? <ChevronRight size={15} /> : <ChevronDown size={15} />
                      : <span className="toggle-spacer" />}
                  </button>
                  <span className={`status-dot ${row.task.status}`} />
                  <strong>{row.task.title}</strong>
                  <small>{statusLabels[row.task.status]}</small>
                  {isAdmin && (
                    <button
                      className="icon-button danger"
                      title="删除任务"
                      aria-label="删除任务"
                      onClick={async () => {
                        try {
                          await mutateProject(`/api/projects/${state.project.id}/tasks/${row.task.id}`, { method: "DELETE" });
                        } catch (error) {
                          showError(error);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </>
              ) : row.type === "assignment" ? (
                <>
                  <span className="swatch" style={{ background: row.assignment.color }} />
                  <span>{row.assignment.displayName}</span>
                  <small>{statusLabels[row.assignment.status]}</small>
                </>
              ) : (
                <>
                  <span className="swatch busy-swatch" style={{ background: row.member?.color || "#697386" }} />
                  <span>{row.member?.displayName || "成员"}个人日程</span>
                  <small>忙碌</small>
                </>
              )}
            </div>
            <div className="gantt-timeline row-grid" style={{ gridTemplateColumns: period.cells.map((cell) => `${cell.days}fr`).join(" ") }}>
              {period.cells.map((cell) => <div className="grid-cell" key={cell.key} />)}
              {row.type === "assignment" && (
                <AssignmentBar
                  assignment={row.assignment}
                  position={rangePosition(
                    drag?.assignment.id === row.assignment.id ? drag.preview?.startDate || row.assignment.startDate : row.assignment.startDate,
                    drag?.assignment.id === row.assignment.id ? drag.preview?.endDate || row.assignment.endDate : row.assignment.endDate,
                    period
                  )}
                  isAdmin={isAdmin}
                  onDrag={(mode, event) => {
                    if (!isAdmin) {
                      return;
                    }
                    event.preventDefault();
                    setDrag({
                      assignment: row.assignment,
                      mode,
                      startX: event.clientX,
                      initialStart: row.assignment.startDate,
                      initialEnd: row.assignment.endDate,
                      preview: { startDate: row.assignment.startDate, endDate: row.assignment.endDate }
                    });
                  }}
                />
              )}
              {row.type === "busy" && (
                <BusyBar
                  slot={row.slot}
                  member={row.member}
                  position={rangePosition(eventDate(row.slot.startAt), eventEndDate(row.slot), period)}
                />
              )}
              {row.type === "task" && (milestonesByTask.get(row.task.id) || []).map((milestone) => {
                const position = rangePosition(milestone.date, milestone.date, period);
                if (!position) {
                  return null;
                }
                return (
                  <button
                    key={milestone.id}
                    className="milestone-flag"
                    style={{ left: position.left, background: milestone.color }}
                    title={`${milestone.title} · ${milestone.date}`}
                    aria-label={milestone.title}
                    onClick={async () => {
                      if (!isAdmin) {
                        return;
                      }
                      try {
                        await mutateProject(`/api/projects/${state.project.id}/milestones/${milestone.id}`, { method: "DELETE" });
                      } catch (error) {
                        showError(error);
                      }
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssignmentBar({ assignment, position, isAdmin, onDrag }) {
  if (!position) {
    return null;
  }
  return (
    <div
      className={`assignment-bar ${isAdmin ? "draggable" : ""}`}
      style={{ left: position.left, width: position.width, background: assignment.color }}
      onMouseDown={(event) => onDrag("move", event)}
      title={`${assignment.displayName}: ${assignment.startDate} - ${assignment.endDate}`}
    >
      {isAdmin && <span className="resize left" onMouseDown={(event) => { event.stopPropagation(); onDrag("start", event); }} />}
      <span>{assignment.displayName}</span>
      {isAdmin && <span className="resize right" onMouseDown={(event) => { event.stopPropagation(); onDrag("end", event); }} />}
    </div>
  );
}

function BusyBar({ slot, member, position }) {
  if (!position) {
    return null;
  }
  return (
    <div
      className="assignment-bar busy-bar"
      style={{ left: position.left, width: position.width, background: member?.color || "#697386" }}
      title={`${member?.displayName || "成员"}个人忙碌: ${slot.startAt.replace("T", " ")} - ${slot.endAt.replace("T", " ")}`}
    >
      <span>忙碌</span>
    </div>
  );
}

function RequestsPanel({ state, isAdmin, mutateProject, showError }) {
  const visible = isAdmin ? state.requests.filter((request) => request.status === "pending") : state.requests.filter((request) => request.requesterId === state.currentMember.userId);
  return (
    <section>
      <h3>审批</h3>
      <div className="request-list">
        {visible.length === 0 && <div className="empty-line">暂无申请</div>}
        {visible.map((request) => (
          <div className="request-item" key={request.id}>
            <strong>{request.requesterDisplayName}</strong>
            <span>{formatRequest(request)}</span>
            <small>{request.status === "pending" ? "待审批" : request.status === "approved" ? "已通过" : "已拒绝"}</small>
            {isAdmin && (
              <div className="row-actions">
                <button
                  className="icon-button success"
                  title="通过"
                  aria-label="通过"
                  onClick={async () => {
                    try {
                      await mutateProject(`/api/projects/${state.project.id}/requests/${request.id}/approve`, { method: "POST", body: {} });
                    } catch (error) {
                      showError(error);
                    }
                  }}
                >
                  <Check size={15} />
                </button>
                <button
                  className="icon-button danger"
                  title="拒绝"
                  aria-label="拒绝"
                  onClick={async () => {
                    try {
                      await mutateProject(`/api/projects/${state.project.id}/requests/${request.id}/reject`, { method: "POST", body: {} });
                    } catch (error) {
                      showError(error);
                    }
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function BusyPanel({ state }) {
  const byUser = new Map(state.members.map((member) => [member.userId, member]));
  return (
    <section>
      <h3>成员忙闲</h3>
      <div className="busy-list">
        {state.busySlots.length === 0 && <div className="empty-line">暂无忙闲</div>}
        {state.busySlots.slice(0, 12).map((slot, index) => (
          <div key={`${slot.userId}-${slot.startAt}-${index}`} className="busy-row">
            <span className="swatch" style={{ background: byUser.get(slot.userId)?.color || "#64748b" }} />
            <span>{byUser.get(slot.userId)?.displayName || "成员"}</span>
            <small>{slot.startAt.replace("T", " ")} - {slot.endAt.replace("T", " ")}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function PersonalMode({ projects, state, projectId, events, scale, setScale, selectedDate, setSelectedDate, reloadPersonal, reloadProject, showError }) {
  const [eventForm, setEventForm] = useState({
    title: "",
    startAt: `${selectedDate}T09:00`,
    endAt: `${selectedDate}T10:00`,
    allDay: false
  });
  const [submitForm, setSubmitForm] = useState({
    eventId: "",
    mode: "existing",
    taskId: "",
    title: "",
    description: "",
    startDate: selectedDate,
    endDate: selectedDate,
    status: "todo"
  });

  useEffect(() => {
    setEventForm((current) => ({ ...current, startAt: `${selectedDate}T09:00`, endAt: `${selectedDate}T10:00` }));
    setSubmitForm((current) => ({ ...current, startDate: selectedDate, endDate: selectedDate }));
  }, [selectedDate]);

  useEffect(() => {
    if (!submitForm.taskId && state.tasks[0]) {
      setSubmitForm((current) => ({ ...current, taskId: state.tasks[0].id }));
    }
    if (!submitForm.eventId && events.find((event) => !event.isTeamEvent)) {
      setSubmitForm((current) => ({ ...current, eventId: events.find((event) => !event.isTeamEvent)?.id || "" }));
    }
  }, [state.tasks, events, submitForm.taskId, submitForm.eventId]);

  const refreshAll = async () => {
    await reloadPersonal();
    await reloadProject(projectId);
  };

  return (
    <main className="workspace">
      <div className="workspace-toolbar">
        <div className="toolbar-title">
          <h2>个人日程</h2>
          <span>{projects.find((project) => project.id === projectId)?.name || state.project.name}</span>
        </div>
        <Segmented
          value={scale}
          onChange={setScale}
          options={[
            ["day", "一天"],
            ["week", "一周"],
            ["month", "一月"],
            ["year", "一年"]
          ]}
        />
        <DateStepper scale={scale} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
      </div>

      <div className="layout-two">
        <aside className="side-panel">
          <section>
            <h3>日程</h3>
            <form className="stack-form" onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api("/api/personal/events", { method: "POST", body: eventForm });
                setEventForm({ title: "", startAt: dateTimeLocal(), endAt: dateTimeLocal(new Date(Date.now() + 3600000)), allDay: false });
                await refreshAll();
              } catch (error) {
                showError(error);
              }
            }}>
              <input value={eventForm.title} onChange={(event) => setEventForm({ ...eventForm, title: event.target.value })} placeholder="标题" />
              <input type="datetime-local" value={eventForm.startAt} onChange={(event) => setEventForm({ ...eventForm, startAt: event.target.value })} />
              <input type="datetime-local" value={eventForm.endAt} onChange={(event) => setEventForm({ ...eventForm, endAt: event.target.value })} />
              <label className="check-row">
                <input type="checkbox" checked={eventForm.allDay} onChange={(event) => setEventForm({ ...eventForm, allDay: event.target.checked })} />
                全天
              </label>
              <button><Plus size={16} />添加日程</button>
            </form>
          </section>
          <section>
            <h3>加入团队</h3>
            <form className="stack-form" onSubmit={async (event) => {
              event.preventDefault();
              try {
                const type = submitForm.mode === "existing" ? "personal_to_team_assignment" : "personal_to_team_task";
                await api(`/api/projects/${projectId}/requests`, {
                  method: "POST",
                  body: {
                    type,
                    eventId: submitForm.eventId,
                    taskId: submitForm.taskId,
                    title: submitForm.title,
                    description: submitForm.description,
                    startDate: submitForm.startDate,
                    endDate: submitForm.endDate,
                    status: submitForm.status
                  }
                });
                await refreshAll();
              } catch (error) {
                showError(error);
              }
            }}>
              <select value={submitForm.eventId} onChange={(event) => setSubmitForm({ ...submitForm, eventId: event.target.value })}>
                <option value="">选择个人日程</option>
                {events.filter((item) => !item.isTeamEvent).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
              <Segmented
                value={submitForm.mode}
                onChange={(mode) => setSubmitForm({ ...submitForm, mode })}
                options={[
                  ["existing", "已有任务"],
                  ["new", "新任务"]
                ]}
              />
              {submitForm.mode === "existing" ? (
                <select value={submitForm.taskId} onChange={(event) => setSubmitForm({ ...submitForm, taskId: event.target.value })}>
                  {state.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
                </select>
              ) : (
                <>
                  <input value={submitForm.title} onChange={(event) => setSubmitForm({ ...submitForm, title: event.target.value })} placeholder="团队任务名称" />
                  <textarea value={submitForm.description} onChange={(event) => setSubmitForm({ ...submitForm, description: event.target.value })} placeholder="描述" />
                </>
              )}
              <div className="form-grid">
                <input type="date" value={submitForm.startDate} onChange={(event) => setSubmitForm({ ...submitForm, startDate: event.target.value })} />
                <input type="date" value={submitForm.endDate} onChange={(event) => setSubmitForm({ ...submitForm, endDate: event.target.value })} />
              </div>
              <select value={submitForm.status} onChange={(event) => setSubmitForm({ ...submitForm, status: event.target.value })}>
                {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <button><Plus size={16} />提交审批</button>
            </form>
          </section>
        </aside>
        <section className="main-panel">
          {scale === "day" ? (
            <DayPlanner selectedDate={selectedDate} events={events} reloadPersonal={reloadPersonal} showError={showError} />
          ) : (
            <PersonalTimeline scale={scale} selectedDate={selectedDate} events={events} />
          )}
        </section>
      </div>
    </main>
  );
}

function DayPlanner({ selectedDate, events, reloadPersonal, showError }) {
  const gridRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const dayEvents = events.filter((event) => eventDate(event.startAt) <= selectedDate && eventEndDate(event) >= selectedDate);
  const allDay = dayEvents.filter((event) => event.allDay);
  const timed = layoutTimedEvents(dayEvents.filter((event) => !event.allDay && eventDate(event.startAt) === selectedDate));

  useEffect(() => {
    if (!drag) {
      return undefined;
    }
    const calculate = (clientY) => {
      const rect = gridRef.current.getBoundingClientRect();
      const rawMinutes = Math.round(((clientY - rect.top - drag.offsetY) / rect.height) * 1440);
      const snapped = Math.max(0, Math.min(1435, Math.round(rawMinutes / 5) * 5));
      const end = Math.min(1440, snapped + drag.duration);
      return { previewStart: snapped, previewEnd: end };
    };
    const move = (event) => {
      const preview = calculate(event.clientY);
      setDrag((current) => current ? { ...current, ...preview } : null);
    };
    const up = async (event) => {
      const preview = calculate(event.clientY);
      const latest = preview.previewStart;
      const end = preview.previewEnd;
      setDrag(null);
      try {
        await api(`/api/personal/events/${drag.event.id}`, {
          method: "PATCH",
          body: {
            title: drag.event.title,
            startAt: setMinutesOnDate(selectedDate, latest),
            endAt: setMinutesOnDate(selectedDate, end),
            allDay: false
          }
        });
        await reloadPersonal();
      } catch (error) {
        showError(error);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, selectedDate, reloadPersonal, showError]);

  return (
    <div className="day-planner">
      <div className="all-day-row">
        <strong>全天</strong>
        <div>
          {allDay.map((event) => (
            <span className={`all-day-pill ${event.isTeamEvent ? "team" : ""}`} key={event.id}>{event.title}</span>
          ))}
        </div>
      </div>
      <div className="hour-grid" ref={gridRef}>
        {Array.from({ length: 24 }, (_, hour) => (
          <div className="hour-line" key={hour}>
            <span>{String(hour).padStart(2, "0")}:00</span>
          </div>
        ))}
        {timed.map((entry) => {
          const start = drag?.event.id === entry.event.id ? drag.previewStart ?? entry.start : entry.start;
          const end = drag?.event.id === entry.event.id ? drag.previewEnd ?? entry.end : entry.end;
          return (
            <div
              className={`personal-block ${entry.event.isTeamEvent ? "team" : ""}`}
              key={entry.event.id}
              style={{
                top: `${(start / 1440) * 100}%`,
                height: `${Math.max(1.8, ((end - start) / 1440) * 100)}%`,
                left: `${8 + entry.lane * (88 / entry.lanes)}%`,
                width: `${Math.max(18, 88 / entry.lanes - 1)}%`
              }}
              onMouseDown={(event) => {
                if (entry.event.isTeamEvent) {
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setDrag({
                  event: entry.event,
                  startMinutes: entry.start,
                  endMinutes: entry.end,
                  duration: entry.end - entry.start,
                  offsetY: event.clientY - rect.top,
                  previewStart: entry.start,
                  previewEnd: entry.end
                });
              }}
            >
              <strong>{entry.event.title}</strong>
              <small>{setMinutesOnDate(selectedDate, start).slice(11)} - {setMinutesOnDate(selectedDate, end).slice(11)}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function layoutTimedEvents(events) {
  const sorted = [...events].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const lanes = [];
  const laidOut = [];
  for (const event of sorted) {
    const start = minutesFromDateTime(event.startAt);
    const end = Math.max(start + 5, minutesFromDateTime(event.endAt));
    let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(end);
    } else {
      lanes[lane] = end;
    }
    laidOut.push({ event, start, end, lane });
  }
  return laidOut.map((entry) => ({ ...entry, lanes: Math.max(1, lanes.length) }));
}

function PersonalTimeline({ scale, selectedDate, events }) {
  const period = getPeriod(scale, selectedDate);
  const visible = events
    .map((event) => ({ event, position: rangePosition(eventDate(event.startAt), eventEndDate(event), period) }))
    .filter((entry) => entry.position);

  return (
    <div className="personal-timeline">
      <div className="gantt-header">
        <div className="gantt-left header-cell">日程</div>
        <div className="gantt-timeline header-grid" style={{ gridTemplateColumns: period.cells.map((cell) => `${cell.days}fr`).join(" ") }}>
          {period.cells.map((cell) => (
            <div className="time-cell" key={cell.key}>
              <strong>{cell.label}</strong>
              {cell.subLabel && <small>周{cell.subLabel}</small>}
            </div>
          ))}
        </div>
      </div>
      <div className="gantt-body">
        {visible.length === 0 && <div className="empty-line">暂无日程</div>}
        {visible.map(({ event, position }) => (
          <div className="gantt-row assignment" key={event.id}>
            <div className="gantt-left row-label">
              <span className={`status-dot ${event.isTeamEvent ? "doing" : "todo"}`} />
              <span>{event.title}</span>
              <small>{event.isTeamEvent ? "团队" : "个人"}</small>
            </div>
            <div className="gantt-timeline row-grid" style={{ gridTemplateColumns: period.cells.map((cell) => `${cell.days}fr`).join(" ") }}>
              {period.cells.map((cell) => <div className="grid-cell" key={cell.key} />)}
              <div className={`assignment-bar ${event.isTeamEvent ? "team" : ""}`} style={{ ...position, background: event.isTeamEvent ? "#0f766e" : "#2f7de1" }}>
                <span>{event.title}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
