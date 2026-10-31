/**
 * 浏览器麦克风 → 服务端实时桥 → 思必驰实时转写。
 *
 * 音频统一转成 16k / 16bit / 单声道 PCM，按 40ms 一帧发送（1280 字节）。
 *
 * 生命周期约定：
 *  - 每次 start 分配一个会话代次（generation）；stop / 卸载会让旧代次失效。
 *  - 每个 await 之后都检查代次，迟到的麦克风流必须就地 stop，不能继续建连接。
 *  - WS 的 error / close 统一走幂等 cleanup，确保麦克风被释放。
 *  - 停止计时器只关闭“停止时那一个 socket”，不会误关新会话。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeTranscription {
  status: RealtimeStatus;
  error: string;
  partial: string;
  lines: string[];
  level: number;
  replaceLine: (index: number, text: string) => void;
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
  const partialRef = useRef("");
  const generationRef = useRef(0);
  const stopTimerRef = useRef<number | undefined>(undefined);

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== undefined) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = undefined;
    }
  }, []);

  /** 释放音频资源；可重复调用。 */
  const cleanupAudio = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = undefined;
    pendingRef.current = new Float32Array(0);
  }, []);

  const cleanupAll = useCallback(() => {
    clearStopTimer();
    cleanupAudio();
    const socket = wsRef.current;
    wsRef.current = undefined;
    if (socket !== undefined) {
      try {
        socket.close();
      } catch {
        // 已关闭则忽略。
      }
    }
  }, [cleanupAudio, clearStopTimer]);

  const pushLine = useCallback((raw: string) => {
    const text = raw.trim();
    if (text === "") return;
    setLines((current) => (current[current.length - 1] === text ? current : [...current, text]));
  }, []);

  const stop = useCallback(() => {
    // 先让旧代次失效：迟到的 getUserMedia / resume 回来时会自行停止。
    generationRef.current += 1;
    clearStopTimer();

    const socket = wsRef.current;
    wsRef.current = undefined;
    if (socket !== undefined) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      } catch {
        // 忽略。
      }
      // 只关“停止时的那一个 socket”；新会话不会被旧计时器误关。
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = undefined;
        try {
          socket.close();
        } catch {
          // 忽略。
        }
      }, 300);
    }

    cleanupAudio();
    setStatus("idle");
    setPartial("");
    partialRef.current = "";
    setLevel(0);
  }, [cleanupAudio, clearStopTimer]);

  const reset = useCallback(() => {
    setLines([]);
    setPartial("");
    setError("");
    setStatus("idle");
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
    cleanupAll();
  }, [cleanupAll]);

  const start = useCallback(async (projectId: string, deviceId?: string) => {
    // 开始新会话前，先让上一代失效并释放资源。
    generationRef.current += 1;
    const generation = generationRef.current;
    clearStopTimer();
    // 上一次会话的 socket 可能还在 300ms 关闭窗口里；新会话开始时直接关掉它。
    const previousSocket = wsRef.current;
    wsRef.current = undefined;
    if (previousSocket !== undefined) {
      try {
        previousSocket.close();
      } catch {
        // 忽略。
      }
    }
    cleanupAudio();

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

      // 授权返回时如果用户已经停止/离开，就地停掉这条流，不继续建连接。
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // 用系统默认采样率采集，再自己降采样到 16k。
      // 直接把 AudioContext 设成 16k 时，部分阵列麦克风会被浏览器重采样成低频振荡，
      // 结果就是“有音量但识别不出任何字”。
      const context = new AudioContext();
      await context.resume();
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        void context.close().catch(() => undefined);
        return;
      }
      contextRef.current = context;

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

      const isCurrent = () => generation === generationRef.current;

      ws.onopen = () => {
        if (isCurrent()) setStatus("live");
      };
      ws.onerror = () => {
        if (!isCurrent()) return;
        setError("实时连接失败，请检查网络或思必驰配置。");
        setStatus("error");
        cleanupAudio();
      };
      ws.onclose = () => {
        if (!isCurrent()) return;
        cleanupAudio();
        setStatus((current) => (current === "live" || current === "connecting" ? "idle" : current));
      };
      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            text?: string;
            message?: string;
          };
          if (message.type === "partial") {
            const text = message.text ?? "";
            if (text === "") return;
            const previous = partialRef.current;
            // rec 是“当前这句”的累计结果：如果新文本不再包含上一句，
            // 说明已经进入下一句，把上一句固定下来，别让它被覆盖。
            if (previous !== "" && !text.startsWith(previous) && !previous.startsWith(text)) {
              pushLine(previous);
            }
            partialRef.current = text;
            setPartial(text);
          }
          if (message.type === "final") {
            const text = (message.text ?? "").trim();
            if (text !== "") pushLine(text);
            partialRef.current = "";
            setPartial("");
          }
          if (message.type === "error") {
            setError(message.message ?? "识别服务出错。");
            setStatus("error");
            cleanupAudio();
          }
        } catch {
          // 忽略格式错误的消息。
        }
      };

      processor.onaudioprocess = (event) => {
        if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const ratio = context.sampleRate / SAMPLE_RATE;
        // 线性插值降采样到 16k；ratio=3 时相当于每 3 个点取一个中间值。
        const outLength = Math.max(1, Math.floor(input.length / ratio));
        const resampled = new Float32Array(outLength);
        for (let index = 0; index < outLength; index += 1) {
          const sourceIndex = index * ratio;
          const low = Math.floor(sourceIndex);
          const high = Math.min(input.length - 1, low + 1);
          const weight = sourceIndex - low;
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
      if (generation !== generationRef.current) return;
      const error = caught as { name?: string; message?: string };
      const name = error.name ?? "";
      setError(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "浏览器拒绝了麦克风权限：点地址栏左侧的图标 → 允许麦克风 → 刷新页面重试。"
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "没有找到可用的麦克风：确认设备已连接，或到 Windows 声音设置里启用输入设备。"
            : name === "NotReadableError" || name === "TrackStartError"
              ? "麦克风被其他软件占用了：关掉腾讯会议 / 钉钉 / 浏览器其他标签页后再试。"
              : name === "OverconstrainedError"
                ? "这个麦克风不支持当前录音参数：换一个输入设备再试。"
                : `启动麦克风失败：${error.message ?? String(caught)}`,
      );
      setStatus("error");
      cleanupAudio();
    }
  }, [cleanupAudio, clearStopTimer, pushLine]);

  const replaceLine = useCallback((index: number, text: string) => {
    setLines((current) => current.map((line, position) => (position === index ? text : line)));
  }, []);

  return { status, error, partial, lines, level, start, stop, reset, replaceLine };
}
