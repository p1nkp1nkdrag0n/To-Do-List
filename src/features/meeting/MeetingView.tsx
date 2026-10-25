import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, Settings2, Trash2, Upload } from "lucide-react";

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

interface LlmConfigView {
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  source: "env" | "file" | "none";
}

interface MeetingViewProps {
  project: ProjectDetail;
  currentUserId: string;
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
/** 运行结果按项目存在 sessionStorage 里，切到甘特图再回来不会丢。 */
const LAST_RUN_KEY = "meeting.lastRun.v2";

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toISOString().slice(11, 19);
}

export function MeetingView({
  project,
  currentUserId,
  collaboration,
  online,
  onJumpToGantt,
}: MeetingViewProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [revealed, setRevealed] = useState(0);
  const [run, setRun] = useState<RunResponse>();
  const [localEvents, setLocalEvents] = useState<MeetingEventView[]>([]);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [recordingName, setRecordingName] = useState("会议录音-60s（预置稿）");
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [manualBusy, setManualBusy] = useState("");
  const [minutesOpen, setMinutesOpen] = useState(false);
  const [minutesText, setMinutesText] = useState("");
  /** 负责人不可替换：勾上之后只允许延期 / 平移，不允许换人或拆分。 */
  const [lockOwners, setLockOwners] = useState(false);
  /** 从纪要建排期时默认先清空，避免同一份纪要跑两次叠出两倍任务。 */
  const [replaceSchedule, setReplaceSchedule] = useState(true);
  const [minutesFileName, setMinutesFileName] = useState("");
  const [uploadingMinutes, setUploadingMinutes] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 顶部提示：录音接口暂时空着，点了给一句人话。 */
  const [notice, setNotice] = useState("");
  const [llmConfig, setLlmConfig] = useState<LlmConfigView>();
  const [llmForm, setLlmForm] = useState({ provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" });
  const [llmBusy, setLlmBusy] = useState("");
  const [llmMessage, setLlmMessage] = useState("");
  /** 这一轮输入的是录音还是纪要，决定左侧正文怎么画。 */
  // 录音接口暂时空着，默认按纪要展示，避免页面一进来就写“上传录音/转写”。
  const [inputMode, setInputMode] = useState<"audio" | "minutes">("minutes");
  /** 右栏两页：平时看日志，发现冲突时自动切到「冲突与方案」。 */
  const [rightTab, setRightTab] = useState<"log" | "conflict">("log");
  /** 手动暂停：录音回放和后台流水线都会停在原地。 */
  const [paused, setPaused] = useState(false);
  /** 只有本轮刚跑完才自动跳甘特图；恢复出来的历史结果不跳。 */
  const [freshRun, setFreshRun] = useState(false);
  const pausedAtRef = useRef(0);
  /** 处理完成后自动跳甘特图的倒计时（秒）；null 表示不跳。 */
  const [jumpIn, setJumpIn] = useState<number | null>(null);
  const startedAtRef = useRef(0);
  const extractedRef = useRef(false);
  const jumpTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const projectId = project.project.id;

  // 处理完成后自动跳甘特图：留 6 秒给人看冲突面板，也可以点「留在本页」取消。
  useEffect(() => {
    if (run === undefined || phase !== "done" || !freshRun) return;
    setJumpIn(6);
    const timer = setInterval(() => {
      setJumpIn((current) => {
        if (current === null) return null;
        if (current <= 1) {
          clearInterval(timer);
          onJumpToGantt();
          return null;
        }
        return current - 1;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [freshRun, run, phase, onJumpToGantt]);

  // 切到甘特图再回来时，把上一次的运行结果恢复出来，别让冲突面板凭空消失。
  useEffect(() => {
    setPhase("idle");
    setRevealed(0);
    setRun(undefined);
    setError("");
    try {
      const raw = sessionStorage.getItem(`${LAST_RUN_KEY}.${currentUserId}.${projectId}`);
      if (raw === null) return;
      const saved = JSON.parse(raw) as {
        run: RunResponse;
        inputMode: "audio" | "minutes";
        minutes: string;
      };
      setRun(saved.run);
      setFreshRun(false);
      setInputMode(saved.inputMode);
      setMinutesText(saved.minutes ?? "");
      setRevealed(DEMO_TRANSCRIPT.length);
      setPhase("done");
      setUndoAvailable(saved.run.undoAvailable ?? false);
    } catch {
      // 存储被禁用或数据损坏时，当作没有历史。
    }
  }, [currentUserId, projectId]);

  const persistRun = useCallback(
    (result: RunResponse) => {
      try {
        sessionStorage.setItem(
          `${LAST_RUN_KEY}.${currentUserId}.${projectId}`,
          JSON.stringify({ run: result, inputMode, minutes: minutesText }),
        );
      } catch {
        // 存不下就算了，不影响主流程。
      }
    },
    [currentUserId, inputMode, minutesText, projectId],
  );

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
  }, [currentUserId, projectId]);

  // 转写回放：按「开始时间 + 进度」算该露几句，不依赖定时器次数，
  // 这样 StrictMode 双挂载也不会跑成两倍速。
  useEffect(() => {
    if (phase !== "transcribing" || paused) return;
    const tick = () => {
      const elapsed = Date.now() - startedAtRef.current;
      setRevealed(
        Math.min(DEMO_TRANSCRIPT.length, Math.floor(elapsed / LINE_INTERVAL_MS)),
      );
    };
    const timer = setInterval(tick, 120);
    tick();
    return () => clearInterval(timer);
  }, [phase, paused]);

  const startProcessing = useCallback(async () => {
    setError("");
    setRun(undefined);
    setRightTab("log");
    setJumpIn(null);
    setPaused(false);
    try {
      sessionStorage.removeItem(`${LAST_RUN_KEY}.${projectId}`);
    } catch {
      // 忽略
    }
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
  }, []);

  const togglePause = useCallback(async () => {
    if (paused) {
      // 继续：把暂停期间的时间补回去，避免转写一下子跳好几行。
      const pausedFor = pausedAtRef.current > 0 ? Date.now() - pausedAtRef.current : 0;
      startedAtRef.current += pausedFor;
      pausedAtRef.current = 0;
      setPaused(false);
      try {
        await api.post("/api/meeting/control", { projectId, action: "resume" });
      } catch {
        // 后台已经跑完了，忽略。
      }
      return;
    }
    pausedAtRef.current = Date.now();
    setPaused(true);
    try {
      await api.post("/api/meeting/control", { projectId, action: "pause" });
    } catch {
      // 没有正在运行的处理，暂停只作用于本地回放。
    }
  }, [paused, projectId]);

  const runPipeline = useCallback(async () => {
    setPhase("running");
    try {
      const result = await api.post<RunResponse>("/api/meeting/run", { projectId });
      setRun(result);
      setFreshRun(true);
      setUndoAvailable(result.undoAvailable ?? false);
      setPhase("done");
      persistRun(result);
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("failed");
    }
  }, [currentUserId, projectId]);

  /** 从粘贴的会议纪要开始：抽任务 → 建库 → 排期 → 修复，全自动。 */
  const startFromMinutes = useCallback(async () => {
    const trimmed = minutesText.trim();
    if (trimmed === "") return;
    setMinutesOpen(false);
    setInputMode("minutes");
    setError("");
    setRun(undefined);
    setRightTab("log");
    setJumpIn(null);
    setPaused(false);
    try {
      sessionStorage.removeItem(`${LAST_RUN_KEY}.${projectId}`);
    } catch {
      // 忽略
    }
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
        lockOwners,
        replaceSchedule,
      });
      setRun(result);
      setFreshRun(true);
      setUndoAvailable(result.undoAvailable ?? false);
      setPhase("done");
      persistRun(result);
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("failed");
    }
  }, [lockOwners, minutesText, projectId, replaceSchedule]);

  /** 上传纪要文件（txt / docx / pdf），后端抽成文字后填进输入框。 */
  const uploadMinutesFile = useCallback(async (file: File) => {
    setUploadingMinutes(true);
    setError("");
    try {
      const response = await fetch("/api/meeting/minutes", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = (await response.json()) as {
        filename?: string;
        text?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `上传失败（HTTP ${response.status}）`);
      }
      setMinutesText(payload.text ?? "");
      setMinutesFileName(payload.filename ?? file.name);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setUploadingMinutes(false);
    }
  }, []);

  useEffect(() => {
    if (notice === "") return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const startFromMinutesPrompt = useCallback(() => {
    setMinutesOpen(true);
    setInputMode("minutes");
  }, []);

  const audioUnsupported = useCallback(() => {
    setNotice("暂时不支持录音上传功能，请改用「粘贴会议纪要」。");
  }, []);

  const openLlmSettings = useCallback(async () => {
    setSettingsOpen(true);
    setLlmMessage("");
    try {
      const view = await api.get<LlmConfigView>("/api/meeting/llm-config");
      setLlmConfig(view);
      setLlmForm({
        provider: view.provider,
        baseUrl: view.baseUrl,
        model: view.model,
        apiKey: "",
      });
    } catch (caught) {
      setLlmMessage(errorMessage(caught));
    }
  }, []);

  const saveLlmConfig = useCallback(async () => {
    setLlmBusy("保存中…");
    setLlmMessage("");
    try {
      const view = await api.put<LlmConfigView>("/api/meeting/llm-config", {
        provider: llmForm.provider,
        baseUrl: llmForm.baseUrl,
        model: llmForm.model,
        apiKey: llmForm.apiKey,
      });
      setLlmConfig(view);
      setLlmForm((current) => ({ ...current, apiKey: "" }));
      setLlmMessage("已保存");
    } catch (caught) {
      setLlmMessage(errorMessage(caught));
    } finally {
      setLlmBusy("");
    }
  }, [llmForm]);

  const testLlmConfig = useCallback(async () => {
    setLlmBusy("测试中…");
    setLlmMessage("");
    try {
      const result = await api.post<{ latencyMs: number; model: string }>(
        "/api/meeting/llm-config/test",
      );
      setLlmMessage(`连接正常：${result.model}，${result.latencyMs}ms`);
    } catch (caught) {
      setLlmMessage(errorMessage(caught));
    } finally {
      setLlmBusy("");
    }
  }, []);

  /** 人工入口：把上一次自动调整退回去。 */
  const handleUndo = useCallback(async () => {
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
  }, [onJumpToGantt, projectId]);

  /** 人工入口：重跑 seed，回到 2 条冲突的开局。 */
  const handleReset = useCallback(
    async (mode: "seed" | "empty" = "seed") => {
      setManualBusy(mode === "empty" ? "正在清空任务…" : "正在还原演示数据…");
      try {
        await api.post("/api/meeting/reset", { projectId, mode });
        window.location.reload();
      } catch (caught) {
        setManualBusy("");
        setError(errorMessage(caught));
      }
    },
    [projectId],
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

  // 等整轮跑完、日志都输出完了，再切到「冲突与方案」。
  useEffect(() => {
    if (run !== undefined && run.conflictsBefore > 0) setRightTab("conflict");
  }, [run]);

  const conflictEvent = run?.events.find((event) => event.type === "conflict.found");
  const planEvent = run?.events.find(
    (event) => event.type === "plan.ready" && Array.isArray(event.detail?.plans),
  );
  const appliedEvent = run?.events.find((event) => event.type === "plan.applied");

  const rawConflicts = (conflictEvent?.detail?.conflicts ?? []) as Array<
    Record<string, unknown>
  >;
  const candidatePlans = (planEvent?.detail?.plans ?? []) as Array<{
    id: string;
    label: string;
    feasible: boolean;
    summary: string;
    after: { conflicts: number; shortfallMinutes: number; slippageDays: number; operations: number };
  }>;

  const conflictsBefore = run?.conflictsBefore ?? 2;
  const conflictsAfter = run?.conflictsAfter ?? 0;
  const progress = Math.min(100, Math.round((revealed / DEMO_TRANSCRIPT.length) * 100));

  return (
    <div className="meeting-view">
      <header className="meeting-toolbar glass-panel">
        <div className="meeting-heading">
          <strong>会议处理</strong>
          <span>
            {project.project.name} ·{" "}
            {inputMode === "minutes"
              ? minutesFileName !== ""
                ? minutesFileName
                : `会议纪要（${minutesText.trim().length} 字）`
              : recordingName}
          </span>
        </div>
        <div className="meeting-phases" aria-label="处理阶段">
          {(inputMode === "minutes"
            ? ["上传纪要", "抽任务", "建排期", "修复"]
            : ["上传录音", "转写", "抽任务", "排期", "修复"]
          ).map((label, index) => {
            const activeIndex =
              inputMode === "minutes"
                ? phase === "idle"
                  ? 0
                  : phase === "running"
                    ? 2
                    : 3
                : phase === "idle"
                  ? 0
                  : phase === "transcribing"
                    ? 1
                    : phase === "running"
                      ? 3
                      : 4;
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
            onClick={audioUnsupported}
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
          {phase === "transcribing" || phase === "running" ? (
            <button className="secondary-button" type="button" onClick={() => void togglePause()}>
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? "继续" : "暂停"}
            </button>
          ) : null}
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
              onClick={() => {
                if (minutesText.trim() !== "") void startFromMinutes();
                else startFromMinutesPrompt();
              }}
            >
              <RotateCcw size={14} /> 重新处理
            </button>
            <button
              className="secondary-button"
              type="button"
              title="录音接口暂时空着"
              onClick={audioUnsupported}
            >
              <Mic size={14} /> 换一段录音
            </button>
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
              onClick={() => void openLlmSettings()}
            >
              <Settings2 size={14} /> AI 设置
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
              <label className="link-button meeting-upload">
                {uploadingMinutes ? "解析中…" : "上传文件（txt / docx / pdf）"}
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.docx,.pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) void uploadMinutesFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
              {minutesFileName !== "" ? (
                <span className="meeting-file-name">{minutesFileName}</span>
              ) : null}
              <label className="meeting-modal-check">
                <input
                  type="checkbox"
                  checked={lockOwners}
                  onChange={(event) => setLockOwners(event.target.checked)}
                />
                锁定负责人（只延期，不换人）
              </label>
              <label className="meeting-modal-check">
                <input
                  type="checkbox"
                  checked={replaceSchedule}
                  onChange={(event) => setReplaceSchedule(event.target.checked)}
                />
                先清空本项目排期
              </label>
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

      {settingsOpen ? (
        <div className="meeting-modal-mask">
          <div className="meeting-modal glass-panel" role="dialog" aria-modal="true">
            <div className="meeting-modal-head">
              <strong>AI 模型设置</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="meeting-settings-grid">
              <label>
                服务商
                <select
                  value={llmForm.provider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    const preset =
                      provider === "siliconflow"
                        ? { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" }
                        : { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
                    setLlmForm((current) => ({ ...current, provider, ...preset }));
                  }}
                >
                  <option value="deepseek">DeepSeek 官方</option>
                  <option value="siliconflow">硅基流动</option>
                  <option value="custom">其他（OpenAI 兼容）</option>
                </select>
              </label>
              <label>
                接口地址
                <input
                  value={llmForm.baseUrl}
                  onChange={(event) => setLlmForm((c) => ({ ...c, baseUrl: event.target.value }))}
                />
              </label>
              <label>
                模型
                <input
                  value={llmForm.model}
                  onChange={(event) => setLlmForm((c) => ({ ...c, model: event.target.value }))}
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  placeholder={llmConfig?.hasKey ? `已保存 ${llmConfig.keyHint}（留空则不修改）` : "sk-..."}
                  value={llmForm.apiKey}
                  onChange={(event) => setLlmForm((c) => ({ ...c, apiKey: event.target.value }))}
                />
              </label>
            </div>
            <div className="meeting-modal-foot">
              <span className="meeting-modal-hint">
                {llmConfig === undefined
                  ? "读取中…"
                  : llmConfig.hasKey
                    ? `当前来源：${llmConfig.source === "env" ? "环境变量" : "本机配置"}（${llmConfig.keyHint}）`
                    : "当前未配置，会退回规则解析"}
              </span>
              {llmMessage !== "" ? <span className="meeting-modal-hint">{llmMessage}</span> : null}
              <button className="secondary-button" type="button" disabled={llmBusy !== ""} onClick={() => void testLlmConfig()}>
                测试连接
              </button>
              <button className="primary-button" type="button" disabled={llmBusy !== ""} onClick={() => void saveLlmConfig()}>
                {llmBusy === "" ? "保存" : llmBusy}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice !== "" ? <div className="meeting-notice">{notice}</div> : null}

      <div className="meeting-body">
        <section className="meeting-pane meeting-main">
          {phase === "idle" ? (
            <div className="meeting-empty">
              <div className="meeting-empty-icon"><Mic size={26} /></div>
              <h2>上传今天的会议录音，或粘贴会议纪要</h2>
              <p>点一次就好：转写（或直接读纪要）、抽任务、排期和冲突修复都会自动完成。</p>
              <button className="primary-button" type="button" onClick={() => void startFromMinutesPrompt()}>
                <FileText size={16} /> 粘贴会议纪要
              </button>
              <button className="secondary-button" type="button" onClick={audioUnsupported}>
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
                  {jumpIn !== null ? (
                    <span className="meeting-countdown">
                      {jumpIn}s 后自动进入甘特图
                      <button
                        className="link-button"
                        type="button"
                        onClick={() => setJumpIn(null)}
                      >
                        留在本页
                      </button>
                    </span>
                  ) : null}
                  <button className="primary-button" type="button" onClick={onJumpToGantt}>
                    查看甘特图 <ArrowRight size={14} />
                  </button>
                </div>
              ) : null}

              {error !== "" ? (
                <div className="inline-error">
                  <AlertCircle size={16} />
                  <div className="inline-error-text">{error}</div>
                  <button className="secondary-button" type="button" onClick={audioUnsupported}>
                    <RotateCcw size={14} /> 重试
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <aside className="meeting-pane meeting-log">
          <div className="meeting-log-head">
            <div className="meeting-log-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "log"}
                className={rightTab === "log" ? "on" : ""}
                onClick={() => setRightTab("log")}
              >
                协作日志 <span>{events.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "conflict"}
                className={rightTab === "conflict" ? "on" : ""}
                onClick={() => setRightTab("conflict")}
              >
                冲突与方案
                {conflictsBefore > 0 ? (
                  <span className="meeting-tab-badge">{conflictsBefore}</span>
                ) : null}
              </button>
            </div>
            <i className={collaboration.connected ? "online-dot" : "offline-dot"} />
          </div>
          {rightTab === "conflict" ? (
            <div className="meeting-log-body meeting-conflict-panel">
              {rawConflicts.length === 0 ? (
                <p className="meeting-log-empty">
                  这次处理没有发现冲突。有冲突时这里会自动打开，并且写明「谁、哪件事、差多少」。
                </p>
              ) : (
                <>
                  {rawConflicts.map((conflict, index) => {
                    const type = String(conflict.type ?? "");
                    const shortfall = Number(conflict.unallocatedMinutes ?? 0) / 60;
                    const estimated = Number(conflict.estimatedHours ?? 0);
                    const available = Number(conflict.availableHours ?? 0);
                    const title = String(conflict.taskTitle ?? "");
                    const who = String(conflict.displayName ?? "");
                    return (
                      <article className="meeting-conflict-card" key={`${type}-${index}`}>
                        <div className="cc-top">
                          <span className="cc-tag">
                            {type === "unallocated_effort"
                              ? "工时排不下"
                              : type === "dependency_inversion"
                                ? "顺序倒了"
                                : type === "overdue"
                                  ? "已过期"
                                  : "可用时间缺失"}
                          </span>
                        </div>
                        {type === "unallocated_effort" ? (
                          <>
                            <h4>{who} · 「{title}」</h4>
                            <div className="cc-numbers">
                              <span>需要 <b>{estimated.toFixed(1)}h</b></span>
                              <span>·</span>
                              <span>本周可用 <b>{available.toFixed(1)}h</b></span>
                              <span>·</span>
                              <span className="cc-short">差 {shortfall.toFixed(1)}h</span>
                            </div>
                            <div className="cc-bar">
                              <i className="avail" style={{ width: `${estimated > 0 ? (available / estimated) * 100 : 0}%` }} />
                            </div>
                            <div className="cc-legend">
                              <span><i className="avail" />可用</span>
                              <span><i className="need" />排不进去</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <h4>
                              「{String(conflict.successorTitle ?? "后续任务")}」比它依赖的
                              「{String(conflict.predecessorTitle ?? "前置任务")}」还早开始
                            </h4>
                            <div className="cc-numbers">
                              <span>计划开始 <b>{String(conflict.successorStart ?? "?")}</b></span>
                              <span>·</span>
                              <span>前置完成 <b>{String(conflict.predecessorFinish ?? "?")}</b></span>
                            </div>
                          </>
                        )}
                      </article>
                    );
                  })}

                  {candidatePlans.length > 0 ? (
                    <>
                      <div className="cc-divider">协调员的方案</div>
                      {candidatePlans.map((plan) => {
                        const applied = appliedEvent?.detail?.planId === plan.id;
                        return (
                          <article
                            className={`meeting-plan-card ${applied ? "on" : ""}`}
                            key={plan.id}
                          >
                            <div className="cc-top">
                              <span className="cc-name">{plan.label}</span>
                              {applied ? (
                                <span className="cc-tag win">已应用</span>
                              ) : plan.feasible ? (
                                <span className="cc-tag">备选</span>
                              ) : (
                                <span className="cc-tag warn">不可行</span>
                              )}
                            </div>
                            <p className="cc-summary">{plan.summary}</p>
                            <div className="cc-metrics">
                              <span className={plan.after.conflicts === 0 ? "good" : "bad"}>
                                冲突 <b>{plan.after.conflicts}</b>
                              </span>
                              <span>延期 <b>{plan.after.slippageDays} 天</b></span>
                              <span>动作 <b>{plan.after.operations}</b></span>
                            </div>
                          </article>
                        );
                      })}
                    </>
                  ) : null}

                  {appliedEvent !== undefined ? (
                    <div className="cc-applied">
                      {String(appliedEvent.message)}
                      {run !== undefined ? `（总耗时 ${(run.durationMs / 1000).toFixed(1)}s）` : ""}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : (
          <div className="meeting-log-body">
            {events.length === 0 ? (
              <p className="meeting-log-empty">还没有日志。点「粘贴会议纪要」后，这里会实时滚动。</p>
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
          )}
        </aside>
      </div>
    </div>
  );
}
