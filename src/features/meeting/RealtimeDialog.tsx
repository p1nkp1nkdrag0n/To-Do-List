/**
 * 实时会议：对着麦克风说话，页面边说边出字，结束后整段填进纪要框。
 */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square, Sparkles } from "lucide-react";

import { api } from "../../lib/api";
import { useRealtimeTranscription } from "./useRealtimeTranscription";

interface DraftTask {
  title: string;
  ownerName: string;
  estimatedHours: number;
  dueDate: string | null;
}

interface RealtimeDialogProps {
  projectId: string;
  onClose: () => void;
  onDone: (text: string) => void;
}

export function RealtimeDialog({ projectId, onClose, onDone }: RealtimeDialogProps) {
  const realtime = useRealtimeTranscription();
  const isEdge = /Edg\//.test(navigator.userAgent);
  const { status, error, partial, lines, level } = realtime;
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [drafting, setDrafting] = useState(false);
  const draftTimer = useRef<number | undefined>(undefined);

  // 边说边拟：每句落定后等 1.2 秒，用累积文本抽一次任务草稿（只读）。
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
        .post<{ tasks: DraftTask[] }>("/api/meeting/draft", { projectId, minutes: text })
        .then((result) => setDrafts(result.tasks))
        .catch(() => undefined)
        .finally(() => setDrafting(false));
    }, 1500);
    return () => window.clearTimeout(draftTimer.current);
  }, [lines, partial, projectId]);

  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((list) => setDevices(list.filter((device) => device.kind === "audioinput")))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => realtime.stop();
    // 只在关闭时停一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transcript = lines.join("\n");

  return (
    <div className="meeting-modal-mask">
      <div className="meeting-modal glass-panel meeting-realtime" role="dialog" aria-modal="true">
        <div className="meeting-modal-head">
          <strong>实时会议记录</strong>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="meeting-modal-hint">
          对着麦克风说话，约 1–2 秒后文字出现在下面；说完点「结束并填入纪要」。
        </p>
        {isEdge ? (
          <p className="form-error">
            检测到 Edge：部分阵列麦克风在 Edge 下会被处理成低频噪声，导致没有字幕。请改用 Chrome 打开同一地址。
          </p>
        ) : null}

        {status === "live" ? (
          <div className="meeting-realtime-meter" title="麦克风电平">
            <span>麦克风</span>
            <i><b style={{ width: `${Math.round(level * 100)}%` }} /></i>
            <span className={level > 0.02 ? "on" : ""}>{level > 0.02 ? "有声音" : "没有声音"}</span>
          </div>
        ) : null}
        {status === "idle" && devices.length > 1 ? (
          <label className="meeting-realtime-device">
            <span>麦克风</span>
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
              <option value="">系统默认</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label !== "" ? device.label : `麦克风 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="meeting-realtime-body">
          {status === "idle" && lines.length === 0 && partial === "" ? (
            <div className="meeting-realtime-empty">
              <Mic size={28} />
              <strong>还没有开始</strong>
              <span>点下面的按钮开始记录；首次会请求麦克风权限。</span>
            </div>
          ) : null}
          {status === "connecting" ? (
            <div className="meeting-realtime-empty">
              <LoaderCircle className="spin" size={26} />
              <strong>正在连接麦克风与识别服务…</strong>
            </div>
          ) : null}
          {(status !== "idle" && status !== "connecting") || lines.length > 0 || partial !== "" ? (
            <div className="meeting-realtime-lines">
              {lines.length === 0 && partial === "" ? (
                <p className="meeting-realtime-placeholder">请开始说话…</p>
              ) : null}
              {lines.map((line, index) => (
                <p key={`${index}-${line.slice(0, 8)}`} className="meeting-realtime-line">
                  {line}
                </p>
              ))}
              {partial !== "" ? <p className="meeting-realtime-partial">{partial}</p> : null}
            </div>
          ) : null}
          {lines.length > 0 || partial !== "" ? (
            <div className="meeting-realtime-drafts">
              <div className="meeting-realtime-drafts-head">
                <Sparkles size={14} />
                <strong>AI 任务草稿</strong>
                <span>{drafting ? "正在拟…" : `${drafts.length} 条`}</span>
              </div>
              {drafts.length === 0 && !drafting ? (
                <p className="meeting-realtime-placeholder">继续说，AI 会边听边拟任务。</p>
              ) : null}
              {drafts.map((draft, index) => (
                <div key={`${draft.title}-${index}`} className="meeting-realtime-draft">
                  <span className="meeting-realtime-draft-title">{draft.title}</span>
                  <span className="meeting-realtime-draft-meta">
                    {draft.ownerName} · {draft.estimatedHours}h
                    {draft.dueDate !== null ? ` · ${draft.dueDate}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {error !== "" ? <p className="form-error">{error}</p> : null}
        </div>

        <div className="meeting-modal-foot">
          <span className="meeting-modal-hint">
            {status === "live" ? `已记录 ${lines.length + (partial !== "" ? 1 : 0)} 句` : ""}
          </span>
          {status === "live" || status === "connecting" ? (
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
          <button
            className="primary-button"
            type="button"
            disabled={transcript.trim() === ""}
            onClick={() => {
              realtime.stop();
              onDone(transcript);
              onClose();
            }}
          >
            结束并填入纪要
          </button>
        </div>
      </div>
    </div>
  );
}
