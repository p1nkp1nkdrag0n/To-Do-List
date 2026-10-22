import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, FileText, LoaderCircle, Mic, RotateCcw, Settings2, Trash2, Upload } from "lucide-react";

import type { CollaborationState } from "../../lib/collaboration-state";
import { api, errorMessage } from "../../lib/api";
import type { ProjectDetail } from "../../types";
import {
  DEMO_AUDIO_SECONDS,
  DEMO_TASKS,
  DEMO_TRANSCRIPT,
  type TranscriptLine,
} from "./transcript-fixture";

type Phase = "idle" | "transcribing" | "running" | "done" | "failed";

interface MeetingEventView {
  type: string;
  at: string;
  message: string;
  detail?: Record<string, unknown>;
  tool?: string;
  status?: "ok" | "error";
  argumentsSummary?: string;
  resultSummary?: string;
  durationMs?: number;
}

interface RunResponse {
  projectId: string;
  conflictsBefore: number;
  conflictsAfter: number;
  appliedPlanId: string | null;
  undoAvailable?: boolean;
  durationMs: number;
  events: MeetingEventView[];
}

interface MeetingViewProps {
  project: ProjectDetail;
  collaboration: CollaborationState & { connected: boolean };
  online: boolean;
  onJumpToGantt: () => void;
}

const LINE_INTERVAL_MS = 850;

const DEMO_MINUTES = `周会纪要
邱业恒：今天主要三件事，接口、甘特图、彩排。
张工：MCP 工具层接口联调我来接，大概十个钟头，这周五之前搞定。我周三下午请假。
李工：甘特图和冲突面板我来调，八个钟头，等张工接口好了我才能开始。
邱业恒：会议录音脚本和话术我来写，四个钟头，这周末前。
邱业恒：最后彩排和录屏我来，四个钟头，下周三之前。`;
/** 处理完成 → 自动进甘特图的停顿；顺便用进度条把这个停顿「可视化」。 */
const JUMP_DELAY_MS = 2_400;

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toISOString().slice(11, 19);
}

export function MeetingView({ project, collaboration, online, onJumpToGantt }: MeetingViewProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [revealed, setRevealed] = useState(0);
  const [run, setRun] = useState<RunResponse>();
  const [localEvents, setLocalEvents] = useState<MeetingEventView[]>([]);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [jumpProgress, setJumpProgress] = useState(0);
  const [recordingName, setRecordingName] = useState("会议录音-60s（预置稿）");
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [manualBusy, setManualBusy] = useState("");
  const [minutesOpen, setMinutesOpen] = useState(false);
  const [minutesText, setMinutesText] = useState("");
  /** 这一轮输入的是录音还是纪要，决定左侧正文怎么画。 */
  const [inputMode, setInputMode] = useState<"audio" | "minutes">("audio");
  const startedAtRef = useRef(0);
  const extractedRef = useRef(false);
  const jumpTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const projectId = project.project.id;

  useEffect(() => {
    setPhase("idle");
    setRevealed(0);
    setRun(undefined);
    setError("");
  }, [projectId]);

  // 刷新页面后也要知道还能不能撤销，否则按钮会无端变灰。
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ undoAvailable: boolean }>(`/api/meeting/status?projectId=${encodeURIComponent(projectId)}`)
      .then((status) => {
        if (!cancelled) setUndoAvailable(status.undoAvailable);
      })
      .catch(() => {
        if (!cancelled) setUndoAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 转写回放：按「开始时间 + 进度」算该露几句，不依赖定时器次数，
  // 这样 StrictMode 双挂载也不会跑成两倍速。
  useEffect(() => {
    if (phase !== "transcribing") return;
    const tick = () => {
      const elapsed = Date.now() - startedAtRef.current;
      setRevealed(
        Math.min(DEMO_TRANSCRIPT.length, Math.floor(elapsed / LINE_INTERVAL_MS)),
      );
    };
    const timer = setInterval(tick, 120);
    tick();
    return () => clearInterval(timer);
  }, [phase]);

  const clearJumpTimer = useCallback(() => {
    if (jumpTimerRef.current !== undefined) {
      clearInterval(jumpTimerRef.current);
      jumpTimerRef.current = undefined;
    }
  }, []);

  const startJumpCountdown = useCallback(() => {
    clearJumpTimer();
    setJumpProgress(0);
    const startedAt = Date.now();
    jumpTimerRef.current = setInterval(() => {
      const percent = Math.min(100, ((Date.now() - startedAt) / JUMP_DELAY_MS) * 100);
      setJumpProgress(percent);
      if (percent >= 100) {
        clearJumpTimer();
        onJumpToGantt();
      }
    }, 50);
  }, [clearJumpTimer, onJumpToGantt]);

  useEffect(() => clearJumpTimer, [clearJumpTimer]);

  const startProcessing = useCallback(async () => {
    clearJumpTimer();
    setJumpProgress(0);
    setError("");
    setRun(undefined);
    setRevealed(0);
    extractedRef.current = false;
    startedAtRef.current = Date.now();
    setInputMode("audio");
    setLocalEvents([
      {
        type: "session.started",
        at: new Date().toISOString(),
        message: `已收到会议录音（${DEMO_AUDIO_SECONDS} 秒），开始转写`,
      },
    ]);
    setPhase("transcribing");
  }, [clearJumpTimer]);

  const runPipeline = useCallback(async () => {
    setPhase("running");
    try {
      const result = await api.post<RunResponse>("/api/meeting/run", { projectId });
      setRun(result);
      setUndoAvailable(result.undoAvailable ?? false);
      setPhase("done");
      startJumpCountdown();
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("failed");
    }
  }, [projectId, startJumpCountdown]);

  /** 从粘贴的会议纪要开始：抽任务 → 建库 → 排期 → 修复，全自动。 */
  const startFromMinutes = useCallback(async () => {
    const trimmed = minutesText.trim();
    if (trimmed === "") return;
    clearJumpTimer();
    setMinutesOpen(false);
    setInputMode("minutes");
    setError("");
    setRun(undefined);
    setRevealed(DEMO_TRANSCRIPT.length);
    setLocalEvents([
      {
        type: "session.started",
        at: new Date().toISOString(),
        message: `已收到会议纪要（${trimmed.length} 字），开始抽取待办`,
      },
    ]);
    setPhase("running");
    try {
      const result = await api.post<RunResponse>("/api/meeting/run", {
        projectId,
        minutes: trimmed,
      });
      setRun(result);
      setUndoAvailable(result.undoAvailable ?? false);
      setPhase("done");
      startJumpCountdown();
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("failed");
    }
  }, [clearJumpTimer, minutesText, projectId, startJumpCountdown]);

  /** 人工入口：把上一次自动调整退回去。 */
  const handleUndo = useCallback(async () => {
    clearJumpTimer();
    setManualBusy("正在撤销…");
    try {
      const result = await api.post<{ reverted: number; skipped: string[] }>(
        "/api/meeting/undo",
        { projectId },
      );
      setUndoAvailable(false);
      setManualBusy(`已撤销 ${result.reverted} 个动作`);
      window.setTimeout(() => {
        setManualBusy("");
        onJumpToGantt();
      }, 900);
    } catch (caught) {
      setManualBusy("");
      setError(errorMessage(caught));
    }
  }, [clearJumpTimer, onJumpToGantt, projectId]);

  /** 人工入口：重跑 seed，回到 2 条冲突的开局。 */
  const handleReset = useCallback(
    async (mode: "seed" | "empty" = "seed") => {
      clearJumpTimer();
      setManualBusy(mode === "empty" ? "正在清空任务…" : "正在还原演示数据…");
      try {
        await api.post("/api/meeting/reset", { projectId, mode });
        window.location.reload();
      } catch (caught) {
        setManualBusy("");
        setError(errorMessage(caught));
      }
    },
    [clearJumpTimer, projectId],
  );

  // 转写播完就自动进入处理，不需要再点。
  useEffect(() => {
    if (phase !== "transcribing" || revealed < DEMO_TRANSCRIPT.length) return;
    if (!extractedRef.current) {
      extractedRef.current = true;
      setLocalEvents((current) => [
        ...current,
        {
          type: "tool.call",
          at: new Date().toISOString(),
          message: `转写完成，抽出 ${DEMO_TASKS.length} 条待办`,
          tool: "extract_tasks",
          resultSummary: `${DEMO_TASKS.length} 条待办（含负责人 / 工时 / 依赖）`,
          durationMs: 0,
        },
      ]);
    }
    void runPipeline();
  }, [phase, revealed, runPipeline]);

  const liveEvents = useMemo(() => {
    const since = startedAtRef.current;
    return collaboration.meetingEvents.filter((event) => new Date(event.at).getTime() >= since);
  }, [collaboration.meetingEvents]);

  const events: MeetingEventView[] = useMemo(() => {
    if (run !== undefined) return run.events as unknown as MeetingEventView[];
    return [...localEvents, ...liveEvents];
  }, [run, localEvents, liveEvents]);

  const conflictsBefore = run?.conflictsBefore ?? 2;
  const conflictsAfter = run?.conflictsAfter ?? 0;
  const progress = Math.min(100, Math.round((revealed / DEMO_TRANSCRIPT.length) * 100));

  return (
    <div className="meeting-view">
      <header className="meeting-toolbar glass-panel">
        <div className="meeting-heading">
          <strong>会议处理</strong>
          <span>{project.project.name} · {recordingName}</span>
        </div>
        <div className="meeting-phases" aria-label="处理阶段">
          {["上传录音", "转写", "抽任务", "排期", "修复"].map((label, index) => {
            const activeIndex =
              phase === "idle" ? 0 : phase === "transcribing" ? 1 : phase === "running" ? 3 : 4;
            return (
              <span key={label} className={index <= activeIndex ? "on" : ""}>
                {label}
              </span>
            );
          })}
        </div>
        <div className="meeting-actions">
          <button
            className="primary-button"
            type="button"
            disabled={phase === "transcribing" || phase === "running"}
            onClick={() => void startProcessing()}
          >
            {phase === "transcribing" || phase === "running" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Upload size={16} />
            )}
            上传会议录音
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={phase === "transcribing" || phase === "running"}
            onClick={() => setMinutesOpen(true)}
          >
            <FileText size={15} /> 粘贴会议纪要
          </button>
          <button
            className="secondary-button"
            type="button"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((current) => !current)}
          >
            <Settings2 size={15} /> 手动
          </button>
        </div>
        {manualOpen ? (
          <div className="meeting-manual glass-panel">
            <p>
              默认全自动；只有出问题才需要动这里。
              {!undoAvailable ? "（「撤销」要等系统自动调整过一次才可用）" : ""}
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={manualBusy !== ""}
              onClick={() => void startProcessing()}
            >
              <RotateCcw size={14} /> 重新处理
            </button>
            <label className="secondary-button meeting-file-button" title="选一个音频文件（转写仍为本地回放，等 ASR 接入后生效）">
              <Mic size={14} /> 换一段录音
              <input
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) setRecordingName(file.name);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={manualBusy !== "" || !undoAvailable}
              title={undoAvailable ? "把排期退回自动调整之前" : "没有可撤销的调整"}
              onClick={() => void handleUndo()}
            >
              <RotateCcw size={14} /> 撤销本次调整
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={manualBusy !== ""}
              title="重跑 seed 脚本，回到 2 条冲突的开局"
              onClick={() => void handleReset()}
            >
              <AlertCircle size={14} /> 还原演示数据
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={manualBusy !== ""}
              title="只清空本项目任务，保留成员和可用时间，用来接会议纪要"
              onClick={() => void handleReset("empty")}
            >
              <Trash2 size={14} /> 清空任务
            </button>
            {manualBusy !== "" ? <span className="meeting-manual-status">{manualBusy}</span> : null}
          </div>
        ) : null}
      </header>

      {minutesOpen ? (
        <div className="meeting-modal-mask">
          <div className="meeting-modal glass-panel" role="dialog" aria-modal="true">
            <div className="meeting-modal-head">
              <strong>粘贴会议纪要</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setMinutesOpen(false)}
              >
                ×
              </button>
            </div>
            <textarea
              value={minutesText}
              placeholder="把会议纪要贴进来，例如：&#10;张工：MCP 接口联调，十个钟头，这周五前。&#10;李工：甘特图联调，八个钟头，等张工接口好了再开始。"
              onChange={(event) => setMinutesText(event.target.value)}
            />
            <div className="meeting-modal-foot">
              <button
                className="link-button"
                type="button"
                onClick={() => setMinutesText(DEMO_MINUTES)}
              >
                填入示例纪要
              </button>
              <span className="meeting-modal-hint">
                会先用 DeepSeek 抽任务；没有 key 时自动退回规则解析。
              </span>
              <button className="secondary-button" type="button" onClick={() => setMinutesOpen(false)}>
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={minutesText.trim() === ""}
                onClick={() => void startFromMinutes()}
              >
                开始处理
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="meeting-body">
        <section className="meeting-pane meeting-main">
          {phase === "idle" ? (
            <div className="meeting-empty">
              <div className="meeting-empty-icon"><Mic size={26} /></div>
              <h2>上传今天的会议录音</h2>
              <p>点一次「上传会议录音」，转写、抽任务、排期和冲突修复都会自动完成。</p>
              <button className="primary-button" type="button" onClick={() => void startProcessing()}>
                <Upload size={16} /> 上传会议录音
              </button>
              {!online ? <p className="meeting-hint">当前离线：上传后只做本地演示。</p> : null}
            </div>
          ) : (
            <>
              {inputMode === "minutes" ? (
                <>
                  <div className="meeting-transcript-head">
                    <span>会议纪要</span>
                    <span className="meeting-timer">{minutesText.trim().length} 字</span>
                    <span className="meeting-progress"><i style={{ width: "100%" }} /></span>
                  </div>
                  <div className="meeting-transcript">
                    <pre className="meeting-minutes-text">{minutesText.trim()}</pre>
                  </div>
                </>
              ) : (
                <>
                  <div className="meeting-transcript-head">
                    <span>会议正文</span>
                    <span className="meeting-timer">
                      {Math.round((revealed / DEMO_TRANSCRIPT.length) * DEMO_AUDIO_SECONDS)}s / {DEMO_AUDIO_SECONDS}s
                    </span>
                    <span className="meeting-progress"><i style={{ width: `${progress}%` }} /></span>
                  </div>
                  <div className="meeting-transcript">
                    {DEMO_TRANSCRIPT.slice(0, revealed).map((line: TranscriptLine, index) => (
                      <div className="meeting-line" key={`${line.atMs}-${index}`}>
                        <div className="meeting-who">
                          <b>{line.speaker}</b>
                          <span>{Math.floor(line.atMs / 1000)}s</span>
                        </div>
                        <p>{line.text}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {inputMode === "minutes" && run !== undefined ? (
                <div className="meeting-cards">
                  {(run.events
                    .find((event) => event.type === "plan.ready" && Array.isArray(event.detail?.tasks))
                    ?.detail?.tasks as Array<{ title: string; owner: string; hours: number }> | undefined
                  )?.map((task, index) => (
                    <article className="meeting-card" key={`${task.title}-${index}`}>
                      <h3>{task.title}</h3>
                      <div className="meeting-meta">
                        <span>{task.owner}</span>
                        <span>{task.hours}h</span>
                        <span>来自纪要</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : revealed >= DEMO_TRANSCRIPT.length ? (
                <div className="meeting-cards">
                  {DEMO_TASKS.map((task) => {
                    const broken =
                      phase === "done" &&
                      run !== undefined &&
                      run.conflictsBefore > 0 &&
                      (task.key === "T2" || task.key === "T3");
                    return (
                      <article className={`meeting-card ${broken && conflictsAfter > 0 ? "warn" : ""}`} key={task.key}>
                        <h3>{task.title}</h3>
                        <div className="meeting-meta">
                          <span>{task.owner}</span>
                          <span>{task.hours}h</span>
                          <span>{task.startHint}</span>
                          {task.dependency ? <span className="dep">{task.dependency}</span> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}

              {run !== undefined ? (
                <div className={`meeting-result ${conflictsAfter === 0 ? "ok" : "bad"}`}>
                  <AlertCircle size={16} />
                  <span>
                    自动修复完成：冲突 {conflictsBefore} → {conflictsAfter}，
                    应用方案 <code>{run.appliedPlanId ?? "无"}</code>，耗时{" "}
                    {(run.durationMs / 1000).toFixed(1)}s
                  </span>
                  <span className="meeting-countdown">
                    {Math.max(0, Math.ceil((JUMP_DELAY_MS * (1 - jumpProgress / 100)) / 1000))}s 后进入甘特图
                    <i><b style={{ width: `${jumpProgress}%` }} /></i>
                  </span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      clearJumpTimer();
                      onJumpToGantt();
                    }}
                  >
                    立即查看 <ArrowRight size={14} />
                  </button>
                </div>
              ) : null}

              {error !== "" ? <div className="inline-error">{error}</div> : null}
            </>
          )}
        </section>

        <aside className="meeting-pane meeting-log">
          <div className="meeting-log-head">
            <strong>协作日志</strong>
            <span>{events.length} 条</span>
            <i className={collaboration.connected ? "online-dot" : "offline-dot"} />
          </div>
          <div className="meeting-log-body">
            {events.length === 0 ? (
              <p className="meeting-log-empty">还没有日志。点「上传会议录音」后，这里会实时滚动。</p>
            ) : (
              events.map((event, index) => (
                <div className={`meeting-entry ${event.type}`} key={`${event.at}-${index}`}>
                  <span className="ts">{clock(event.at)}</span>
                  <div>
                    {event.type === "tool.call" ? (
                      <>
                        <code className="tool">{event.tool}</code>
                        <div className="res">
                          {event.resultSummary}
                          {event.durationMs !== undefined ? <em>{event.durationMs}ms</em> : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="ev">{event.message}</span>
                        {event.detail !== undefined && event.type === "plan.ready" ? (
                          <div className="res">
                            {Array.isArray(event.detail.plans)
                              ? (event.detail.plans as Array<{ id: string; label: string; feasible: boolean }>)
                                  .map((plan) => `${plan.id} ${plan.label}${plan.feasible ? "（可行）" : ""}`)
                                  .join(" · ")
                              : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
