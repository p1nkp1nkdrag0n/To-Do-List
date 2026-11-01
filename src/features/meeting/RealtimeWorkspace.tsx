/**
 * 实时会议工作区：左边字幕（只增不减），右边 AI 任务草稿，底部控制。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Mic, Sparkles, Square } from "lucide-react";

import { api } from "../../lib/api";
import { createReviewTasks, removeReviewTask, type DraftTask, type ReviewTask, type RealtimeMember } from "./review-tasks";
import { useRealtimeTranscription } from "./useRealtimeTranscription";

export type { ReviewTask, RealtimeMember } from "./review-tasks";

interface RealtimeWorkspaceProps {
  projectId: string;
  members: RealtimeMember[];
  onExit: () => void;
  onFinish: (text: string, tasks: ReviewTask[], scheduleRevision: number) => Promise<boolean>;
}

export function RealtimeWorkspace({ projectId, members, onExit, onFinish }: RealtimeWorkspaceProps) {
  const realtime = useRealtimeTranscription();
  const { replaceLine } = realtime;
  const isEdge = /Edg\//.test(navigator.userAgent);
  const { status, error, partial, lines, level } = realtime;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState<{
    text: string;
    tasks: ReviewTask[];
    scheduleRevision: number;
  } | null>(null);
  const [submitError, setSubmitError] = useState("");
  const draftTimer = useRef<number | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const correctedCount = useRef(0);
  const correcting = useRef(false);

  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((list) => setDevices(list.filter((device) => device.kind === "audioinput")))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (status !== "live") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lines, partial]);

  useEffect(() => {
    if (status !== "live" && status !== "idle") return;
    if (members.length === 0 || correcting.current) return;
    if (correctedCount.current >= lines.length) return;
    correcting.current = true;
    const index = correctedCount.current;
    const text = lines[index] ?? "";
    correctedCount.current += 1;
    void api
      .post<{ text: string }>("/api/meeting/correct", { text, hotwords: members })
      .then((result) => {
        if (result.text !== "" && result.text !== text) replaceLine(index, result.text);
      })
      .catch(() => undefined)
      .finally(() => {
        correcting.current = false;
      });
  }, [lines, members, replaceLine, status]);

  // 边说边拟：每句落定后等 1.2 秒，用最近 2000 字抽一次草稿（只读）。
  useEffect(() => {
    const text = [...lines, partial].filter((line) => line.trim() !== "").join("\n");
    if (text.trim() === "") {
      setDrafts([]);
      return;
    }
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      setDrafting(true);
      void api
        .post<{ tasks: DraftTask[] }>("/api/meeting/draft", {
          projectId,
          minutes: text.slice(-2000),
        })
        .then((result) => {
          setDrafts((current) => {
            const merged = new Map(current.map((draft) => [draft.title, draft]));
            for (const draft of result.tasks) merged.set(draft.title, draft);
            return [...merged.values()];
          });
        })
        .catch(() => undefined)
        .finally(() => setDrafting(false));
    }, 1200);
    return () => window.clearTimeout(draftTimer.current);
  }, [lines, partial, projectId]);

  // 字幕列表 + 正在说的这一句：点结束时当前句子也要带上，不能丢。
  const transcript = useMemo(
    () => [...lines, partial].filter((line) => line.trim() !== "").join("\n"),
    [lines, partial],
  );
  const isLive = status === "live" || status === "connecting";
  const busy = finishing || submitting;
  const hasUnresolvedDependencies = review?.tasks.some((task) => task.unresolvedDependencies.length > 0) ?? false;

  const finish = async () => {
    if (transcript.trim() === "" || busy || review !== null) return;
    realtime.stop();
    setSubmitError("");
    setFinishing(true);
    try {
      const corrected = await api
        .post<{ text: string }>("/api/meeting/correct", { text: transcript })
        .then((result) => result.text)
        .catch(() => transcript);
      // 先按最终文本抽一份任务清单，让用户确认后再建排期。
      const draft = await api
        .post<{ tasks: DraftTask[]; scheduleRevision: number }>("/api/meeting/draft", {
          projectId,
          minutes: corrected,
        })
        .then((result) => result)
        .catch(() => null);
      if (draft === null) {
        setSubmitError("任务草稿生成失败，请重试。");
        return;
      }
      if (draft.tasks.length === 0) {
        setSubmitError("没有识别到任务，原排期未更改。请补充任务内容后重新生成。");
        return;
      }
      setReview({
        text: corrected,
        scheduleRevision: draft.scheduleRevision,
        tasks: createReviewTasks(draft.tasks, members),
      });
    } finally {
      setFinishing(false);
    }
  };

  return (
    <section className="realtime-workspace">
      <header className="realtime-head">
        <div>
          <strong>实时会议</strong>
          <span className="realtime-timer">
            {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
          </span>
          <span className={isLive ? "realtime-dot on" : "realtime-dot"} />
          <span className="realtime-state">
            {status === "live" ? "正在记录" : status === "connecting" ? "连接中" : status === "error" ? "出错" : "未开始"}
          </span>
        </div>
        <div className="realtime-head-actions">
          {status !== "live" ? (
            <select
              disabled={busy || review !== null}
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              className="realtime-device"
            >
              <option value="">系统默认麦克风</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label !== "" ? device.label : `麦克风 ${index + 1}`}
                </option>
              ))}
            </select>
          ) : null}
          {isLive ? (
            <button className="secondary-button" type="button" onClick={() => realtime.stop()}>
              <Square size={14} /> 停止
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy || review !== null}
              onClick={() => {
                correctedCount.current = 0;
                setSeconds(0);
                setDrafts([]);
                setSubmitError("");
                realtime.reset();
                void realtime.start(projectId, deviceId === "" ? undefined : deviceId);
              }}
            >
              <Mic size={15} /> 开始实时记录
            </button>
          )}
          <button className="link-button" type="button" disabled={busy} onClick={onExit}>
            返回会议
          </button>
        </div>
      </header>

      {status === "live" ? (
        <div className="realtime-meter">
          <span>麦克风</span>
          <i><b style={{ width: `${Math.round(level * 100)}%` }} /></i>
          <span className={level > 0.02 ? "on" : ""}>{level > 0.02 ? "有声音" : "没有声音"}</span>
        </div>
      ) : null}
      {isEdge ? (
        <p className="form-error">
          检测到 Edge：部分阵列麦克风在 Edge 下会被处理成低频噪声，导致没有字幕。请改用 Chrome 打开同一地址。
        </p>
      ) : null}
      {error !== "" ? <p className="form-error">{error}</p> : null}

      {review !== null ? (
        <div className="realtime-review">
          <div className="realtime-review-head">
            <strong>确认任务清单</strong>
            <span>确认后会按这份清单建排期，不会重新抽取</span>
          </div>
          <div className="realtime-review-list">
            {review.tasks.map((task, index) => (
              <div className="realtime-review-item" key={task.clientTaskId}>
                <div className="realtime-review-row">
                <input
                  className="realtime-review-title"
                  aria-label={`任务 ${index + 1} 标题`}
                  disabled={submitting}
                  maxLength={60}
                  value={task.title}
                  onChange={(event) => {
                    const next = { ...review, tasks: [...review.tasks] };
                    next.tasks[index] = { ...task, title: event.target.value };
                    setReview(next);
                  }}
                />
                <select
                  aria-label={`任务 ${index + 1} 负责人`}
                  disabled={submitting}
                  value={task.ownerUserId ?? "未分配"}
                  onChange={(event) => {
                    const next = { ...review, tasks: [...review.tasks] };
                    const member = members.find((item) => item.userId === event.target.value);
                    next.tasks[index] = {
                      ...task,
                      ownerUserId: member?.userId ?? null,
                      ownerName: member?.displayName ?? "未分配",
                    };
                    setReview(next);
                  }}
                >
                  <option value="未分配">未分配</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  aria-label={`任务 ${index + 1} 工时`}
                  disabled={submitting}
                  min={0.5}
                  step={0.5}
                  value={task.estimatedHours}
                  onChange={(event) => {
                    const next = { ...review, tasks: [...review.tasks] };
                    next.tasks[index] = { ...task, estimatedHours: Number(event.target.value) };
                    setReview(next);
                  }}
                />
                <button
                  className="link-button"
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setReview({ ...review, tasks: removeReviewTask(review.tasks, task.clientTaskId) });
                  }}
                >
                  删除
                </button>
                </div>
                <div className="realtime-review-dependency">
                  {task.predecessorClientTaskIds.length === 0 && task.unresolvedDependencies.length === 0 ? (
                    <span>无依赖</span>
                  ) : (
                    task.predecessorClientTaskIds.map((id) => (
                      <span key={id} className="realtime-review-dependency-chip">
                        依赖：{review.tasks.find((item) => item.clientTaskId === id)?.title}
                        <button
                          className="link-button"
                          type="button"
                          disabled={submitting}
                          onClick={() => {
                            const next = { ...review, tasks: [...review.tasks] };
                            next.tasks[index] = {
                              ...task,
                              predecessorClientTaskIds: task.predecessorClientTaskIds.filter((item) => item !== id),
                            };
                            setReview(next);
                          }}
                        >
                          移除
                        </button>
                      </span>
                    ))
                  )}
                  {task.unresolvedDependencies.map((title) => (
                    <span key={title} className="realtime-review-dependency-chip">
                      待确认依赖：{title}
                      <select
                        aria-label={`确认「${task.title}」的依赖「${title}」`}
                        value=""
                        disabled={submitting}
                        onChange={(event) => {
                          if (event.target.value === "") return;
                          const next = { ...review, tasks: [...review.tasks] };
                          next.tasks[index] = {
                            ...task,
                            predecessorClientTaskIds: [...new Set([...task.predecessorClientTaskIds, event.target.value])],
                            unresolvedDependencies: task.unresolvedDependencies.filter((item) => item !== title),
                          };
                          setReview(next);
                        }}
                      >
                        <option value="">选择具体前驱…</option>
                        {review.tasks.map((candidate, position) => candidate.clientTaskId !== task.clientTaskId ? (
                          <option key={candidate.clientTaskId} value={candidate.clientTaskId}>
                            任务 {position + 1}：{candidate.title}
                          </option>
                        ) : null)}
                      </select>
                      <button className="link-button" type="button" disabled={submitting} onClick={() => {
                        const next = { ...review, tasks: [...review.tasks] };
                        next.tasks[index] = { ...task, unresolvedDependencies: task.unresolvedDependencies.filter((item) => item !== title) };
                        setReview(next);
                      }}>移除</button>
                    </span>
                  ))}
                  <select
                    className="realtime-review-dependency-select"
                    value=""
                    disabled={submitting}
                    aria-label={`为「${task.title}」添加依赖`}
                    onChange={(event) => {
                      if (event.target.value === "") return;
                      const next = { ...review, tasks: [...review.tasks] };
                      next.tasks[index] = {
                        ...task,
                        predecessorClientTaskIds: [...new Set([...task.predecessorClientTaskIds, event.target.value])],
                      };
                      setReview(next);
                    }}
                  >
                    <option value="">+ 添加依赖…</option>
                    {review.tasks.map((candidate, position) =>
                      candidate.clientTaskId !== task.clientTaskId &&
                      !task.predecessorClientTaskIds.includes(candidate.clientTaskId) ? (
                        <option key={candidate.clientTaskId} value={candidate.clientTaskId}>
                          等待「{candidate.title}」（任务 {position + 1}）完成
                        </option>
                      ) : null)}
                  </select>
                </div>
              </div>
            ))}
          </div>
          {hasUnresolvedDependencies ? <p className="form-error" role="alert">有依赖尚未确认，请选择具体前驱或移除该依赖后再生成排期。</p> : null}
          {submitError !== "" ? <p className="form-error">{submitError}</p> : null}
          <div className="realtime-review-foot">
            <button className="secondary-button" type="button" disabled={submitting} onClick={() => setReview(null)}>
              返回查看字幕
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={review.tasks.length === 0 || submitting || hasUnresolvedDependencies}
              onClick={() => {
                setSubmitError("");
                void (async () => {
                  setSubmitting(true);
                  try {
                    const ok = await onFinish(review.text, review.tasks, review.scheduleRevision);
                    if (!ok) {
                      setSubmitError("提交失败，任务清单与编辑内容已保留，可直接重试。");
                    }
                  } catch {
                    setSubmitError("提交失败，任务清单与编辑内容已保留，可直接重试。");
                  } finally {
                    setSubmitting(false);
                  }
                })();
              }}
            >
              {submitting ? "正在生成…" : "确认并生成排期"}
            </button>
          </div>
        </div>
      ) : (
      <div className="realtime-split">
        <div className="realtime-transcript" ref={transcriptRef}>
          {lines.length === 0 && partial === "" ? (
            <p className="realtime-placeholder">
              {status === "live" ? "请开始说话…" : "点右上角「开始实时记录」，对着麦克风说话。"}
            </p>
          ) : null}
          {lines.map((line, index) => (
            <p key={index} className="realtime-line">
              {line}
            </p>
          ))}
          {partial !== "" ? <p className="realtime-partial">{partial}</p> : null}
        </div>

        <aside className="realtime-drafts">
          <div className="realtime-drafts-head">
            <Sparkles size={15} />
            <strong>AI 任务草稿</strong>
            <span>{drafting ? "正在拟…" : `${drafts.length} 条`}</span>
          </div>
          {drafts.length === 0 ? (
            <p className="realtime-placeholder">说话后，这里会自动出现任务草稿。</p>
          ) : null}
          {drafts.map((draft, index) => (
            <div key={`${draft.title}-${index}`} className="realtime-draft">
              <strong>{draft.title}</strong>
              <span>
                {draft.ownerName}
                {draft.ownerBasis === "pronoun" && (draft.ownerConfidence ?? 0) >= 0.5 ? (
                  <i className="realtime-draft-badge">推断</i>
                ) : null}
                {" · "}
                {draft.estimatedHours}h{draft.dueDate !== null ? ` · ${draft.dueDate}` : ""}
              </span>
            </div>
          ))}
        </aside>
      </div>
      )}

      {review === null ? <footer className="realtime-foot">
        {submitError !== "" ? <p className="form-error" role="alert">{submitError}</p> : null}
        <span className="realtime-hint">
          说完点「结束并生成排期」：会自动纠错人名、抽任务、建排期。
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={transcript.trim() === "" || busy}
          onClick={() => void finish()}
        >
          {finishing ? <LoaderCircle className="spin" size={15} /> : null}
          结束并生成排期
        </button>
      </footer> : null}
    </section>
  );
}
