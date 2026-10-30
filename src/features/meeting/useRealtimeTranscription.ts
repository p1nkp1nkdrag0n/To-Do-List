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
  level: number;
  start: (projectId: string, deviceId?: string) => Promise<void>;
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
  const [level, setLevel] = useState(0);
  const levelAtRef = useRef(0);

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
    setLevel(0);
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

  const start = useCallback(async (projectId: string, deviceId?: string) => {
    setError("");
    setLines([]);
    setPartial("");
    setStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // 指定设备时只传 deviceId；不指定时让浏览器用默认输入。
          ...(deviceId !== undefined && deviceId !== "" ? { deviceId: { exact: deviceId } } : {}),
          // 关闭浏览器的音频处理，避免阵列麦克风被处理成低频振荡。
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      // 用系统默认采样率采集，再自己降采样到 16k。
      // 直接把 AudioContext 设成 16k 时，部分阵列麦克风会被浏览器重采样成低频振荡，
      // 结果就是“有音量但识别不出任何字”。
      const context = new AudioContext();
      contextRef.current = context;
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      // 阵列麦克风有时会带很低的直流/次声漂移，听感是“有音量”，
      // 但识别服务只听到 8Hz 振荡。加一个 80Hz 高通把这段滤掉。
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 80;
      highpass.Q.value = 0.7;
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
        const ratio = context.sampleRate / SAMPLE_RATE;
        // 线性插值降采样到 16k；ratio=3 时相当于每 3 个点取一个中间值。
        const outLength = Math.max(1, Math.floor(input.length / ratio));
        const resampled = new Float32Array(outLength);
        for (let index = 0; index < outLength; index += 1) {
          const source = index * ratio;
          const low = Math.floor(source);
          const high = Math.min(input.length - 1, low + 1);
          const weight = source - low;
          resampled[index] = input[low]! * (1 - weight) + input[high]! * weight;
        }
        // 电平：让用户一眼看出麦克风到底有没有收到声音。
        const now = performance.now();
        if (now - levelAtRef.current > 100) {
          levelAtRef.current = now;
          let peak = 0;
          let sum = 0;
          for (let index = 0; index < resampled.length; index += 1) {
            const value = Math.abs(resampled[index]!);
            peak = Math.max(peak, value);
            sum += value * value;
          }
          const rms = Math.sqrt(sum / resampled.length);
          // 用峰值做“有没有声音”，用 RMS 做强度；安静时快速回落。
          const next = Math.min(1, Math.max(rms * 4, peak * 0.8));
          setLevel((current) => (next < current ? Math.max(next, current * 0.7) : next));
        }
        const merged = new Float32Array(pendingRef.current.length + resampled.length);
        merged.set(pendingRef.current);
        merged.set(resampled, pendingRef.current.length);
        let offset = 0;
        while (merged.length - offset >= FRAME_SAMPLES) {
          const frame = merged.subarray(offset, offset + FRAME_SAMPLES);
          // 不做任何增益：麦克风音量由系统控制，原样送识别。
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
      source.connect(highpass);
      highpass.connect(processor);
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

  return { status, error, partial, lines, level, start, stop, reset };
}
