/**
 * 实时会议工作区：左边字幕（只增不减），右边 AI 任务草稿，底部控制。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Mic, Sparkles, Square } from "lucide-react";

import { api } from "../../lib/api";
import { useRealtimeTranscription } from "./useRealtimeTranscription";

interface DraftTask {
  title: string;
  ownerName: string;
  estimatedHours: number;
  dueDate: string | null;
}

interface RealtimeWorkspaceProps {
  projectId: string;
  onExit: () => void;
  onFinish: (text: string) => Promise<void> | void;
}

export function RealtimeWorkspace({ projectId, onExit, onFinish }: RealtimeWorkspaceProps) {
  const realtime = useRealtimeTranscription();
  const isEdge = /Edg\//.test(navigator.userAgent);
  const { status, error, partial, lines, level } = realtime;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const draftTimer = useRef<number | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

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

  const transcript = useMemo(() => lines.join("\n"), [lines]);
  const isLive = status === "live" || status === "connecting";

  const finish = async () => {
    if (transcript.trim() === "") return;
    realtime.stop();
    setFinishing(true);
    try {
      const corrected = await api
        .post<{ text: string }>("/api/meeting/correct", { text: transcript })
        .then((result) => result.text)
        .catch(() => transcript);
      await onFinish(corrected);
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
              onClick={() => {
                realtime.reset();
                void realtime.start(projectId, deviceId === "" ? undefined : deviceId);
              }}
            >
              <Mic size={15} /> 开始实时记录
            </button>
          )}
          <button className="link-button" type="button" onClick={onExit}>
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

      <div className="realtime-split">
        <div className="realtime-transcript" ref={transcriptRef}>
          {lines.length === 0 && partial === "" ? (
            <p className="realtime-placeholder">
              {status === "live" ? "请开始说话…" : "点右上角「开始实时记录」，对着麦克风说话。"}
            </p>
          ) : null}
          {lines.map((line, index) => (
            <p key={`${index}-${line.slice(0, 10)}`} className="realtime-line">
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
                {draft.ownerName} · {draft.estimatedHours}h{draft.dueDate !== null ? ` · ${draft.dueDate}` : ""}
              </span>
            </div>
          ))}
        </aside>
      </div>

      <footer className="realtime-foot">
        <span className="realtime-hint">
          说完点「结束并生成排期」：会自动纠错人名、抽任务、建排期。
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={transcript.trim() === "" || finishing}
          onClick={() => void finish()}
        >
          {finishing ? <LoaderCircle className="spin" size={15} /> : null}
          结束并生成排期
        </button>
      </footer>
    </section>
  );
}
