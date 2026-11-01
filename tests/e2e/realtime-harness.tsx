import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { useRealtimeTranscription } from "../../src/features/meeting/useRealtimeTranscription";

/**
 * 实时转写 hook 的浏览器测试台。
 *
 * 用真实的 React 生命周期，但把麦克风与 WebSocket 换成可控假实现：
 *  - getUserMedia 返回一条真实 AudioContext 产生的音轨；
 *  - WebSocket 记录所有实例，close() 后 readyState=3；
 *  - 页面只暴露 start / stop / unmount，方便测停止、卸载、重启。
 */
declare global {
  interface Window {
    __rtSockets: FakeSocket[];
    __rtTracks: MediaStreamTrack[];
    __rtDelay: number;
  }
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    window.__rtSockets.push(this);
    window.setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 5);
  }

  send(): void {
    // 音频帧在测试里不需要处理。
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

window.__rtSockets = [];
window.__rtTracks = [];
window.__rtDelay = 0;
window.WebSocket = FakeSocket as unknown as typeof WebSocket;

navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0]!;
  window.__rtTracks.push(track);
  const delay = window.__rtDelay;
  if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
  return destination.stream;
};

function Harness({ onUnmount }: { onUnmount: () => void }) {
  const realtime = useRealtimeTranscription();

  useEffect(() => {
    (window as unknown as { __rt: typeof realtime }).__rt = realtime;
  }, [realtime]);

  return (
    <div>
      <button id="start" type="button" onClick={() => void realtime.start("test-project")}>
        开始
      </button>
      <button id="stop" type="button" onClick={() => realtime.stop()}>
        停止
      </button>
      <button id="unmount" type="button" onClick={onUnmount}>
        卸载
      </button>
      <span id="status">{realtime.status}</span>
    </div>
  );
}

function App() {
  const [visible, setVisible] = useState(true);
  const [generation, setGeneration] = useState(0);

  if (!visible) {
    return (
      <button
        id="remount"
        type="button"
        onClick={() => {
          setGeneration((value) => value + 1);
          setVisible(true);
        }}
      >
        重新挂载
      </button>
    );
  }

  return <Harness key={generation} onUnmount={() => setVisible(false)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
