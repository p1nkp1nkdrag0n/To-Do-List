/**
 * 浏览器麦克风 → 服务端实时桥 → 思必驰实时转写。
 *
 * 音频统一转成 16k / 16bit / 单声道 PCM，按 40ms 一帧发送（1280 字节）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeTranscription {
  status: RealtimeStatus;
  error: string;
  partial: string;
  lines: string[];
  start: (projectId: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 640; // 40ms

export function useRealtimeTranscription(): RealtimeTranscription {
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const processorRef = useRef<ScriptProcessorNode | undefined>(undefined);
  const pendingRef = useRef<Float32Array>(new Float32Array(0));

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = undefined;
    pendingRef.current = new Float32Array(0);
  }, []);

  const stop = useCallback(() => {
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      }
    } catch {
      // ignore
    }
    window.setTimeout(() => {
      wsRef.current?.close();
      wsRef.current = undefined;
    }, 300);
    cleanup();
    setStatus("idle");
    setPartial("");
  }, [cleanup]);

  const reset = useCallback(() => {
    setLines([]);
    setPartial("");
    setError("");
    setStatus("idle");
  }, []);

  useEffect(() => () => {
    wsRef.current?.close();
    cleanup();
  }, [cleanup]);

  const start = useCallback(async (projectId: string) => {
    setError("");
    setLines([]);
    setPartial("");
    setStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${protocol}://${window.location.host}/ws/meeting/realtime?projectId=${encodeURIComponent(projectId)}`,
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => setStatus("live");
      ws.onerror = () => {
        setError("实时连接失败，请检查网络或思必驰配置。");
        setStatus("error");
      };
      ws.onclose = () => {
        if (status !== "error") setStatus((current) => (current === "live" ? "idle" : current));
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            text?: string;
            message?: string;
          };
          if (message.type === "partial") setPartial(message.text ?? "");
          if (message.type === "final") {
            const text = (message.text ?? "").trim();
            if (text !== "") setLines((current) => [...current, text]);
            setPartial("");
          }
          if (message.type === "error") {
            setError(message.message ?? "识别服务出错。");
            setStatus("error");
          }
        } catch {
          // ignore malformed
        }
      };

      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const merged = new Float32Array(pendingRef.current.length + input.length);
        merged.set(pendingRef.current);
        merged.set(input, pendingRef.current.length);
        let offset = 0;
        while (merged.length - offset >= FRAME_SAMPLES) {
          const frame = merged.subarray(offset, offset + FRAME_SAMPLES);
          const pcm = new Int16Array(FRAME_SAMPLES);
          for (let index = 0; index < FRAME_SAMPLES; index += 1) {
            const sample = Math.max(-1, Math.min(1, frame[index]!));
            pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          }
          ws.send(pcm.buffer);
          offset += FRAME_SAMPLES;
        }
        pendingRef.current = merged.slice(offset);
      };
      source.connect(processor);
      processor.connect(context.destination);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        message.includes("Permission") || message.includes("denied")
          ? "浏览器没有麦克风权限，请允许后重试。"
          : `启动麦克风失败：${message}`,
      );
      setStatus("error");
      cleanup();
    }
  }, [cleanup, status]);

  return { status, error, partial, lines, start, stop, reset };
}
