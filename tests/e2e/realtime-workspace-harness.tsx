import { createRoot } from "react-dom/client";

import { MeetingView } from "../../src/features/meeting/MeetingView";
import { RealtimeWorkspace, type ReviewTask } from "../../src/features/meeting/RealtimeWorkspace";
import { initialCollaborationState } from "../../src/lib/collaboration-state";
import "../../src/styles.css";

interface FinishCall {
  text: string;
  tasks: ReviewTask[];
  scheduleRevision: number;
}

interface TestState {
  sockets: FakeSocket[];
  finishCalls: FinishCall[];
  finishMode: "failure" | "pending";
  resolveFinish: ((value: boolean) => void) | null;
  exitCount: number;
  emitFinal: (text: string) => void;
}

declare global {
  interface Window {
    __meetingTest: TestState;
  }
}

// The component and React lifecycle are real; capture/transport are fully synthetic.
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    window.__meetingTest.sockets.push(this);
    window.setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.(new Event("open"));
    }, 5);
  }

  send(): void {}

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

window.__meetingTest = {
  sockets: [],
  finishCalls: [],
  finishMode: "failure",
  resolveFinish: null,
  exitCount: 0,
  emitFinal(text) {
    const socket = this.sockets.at(-1);
    if (!socket || socket.readyState !== FakeSocket.OPEN) throw new Error("No synthetic socket is open");
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "final", text }) }));
  },
};
window.WebSocket = FakeSocket as unknown as typeof WebSocket;

navigator.mediaDevices.enumerateDevices = async () => [];
navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext();
  return context.createMediaStreamDestination().stream;
};

const members = [
  { userId: "member-a", displayName: "张同学" },
  { userId: "member-b", displayName: "李同学" },
];
const workspace = (
  <RealtimeWorkspace
    projectId="synthetic-project"
    members={members}
    onExit={() => { window.__meetingTest.exitCount += 1; }}
    onFinish={async (text, tasks, scheduleRevision) => {
      window.__meetingTest.finishCalls.push(structuredClone({ text, tasks, scheduleRevision }));
      if (window.__meetingTest.finishMode === "failure") return false;
      return await new Promise<boolean>((resolve) => { window.__meetingTest.resolveFinish = resolve; });
    }}
  />
);
const meetingView = (
  <MeetingView
    project={{
      project: {
        id: "synthetic-project", name: "合成项目", description: "", timezone: "Asia/Shanghai",
        startDate: null, endDate: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 1,
      },
      members: members.map((member) => ({ ...member, username: member.userId, joinedAt: "2026-01-01", revision: 1, color: "#222222" })),
    }}
    currentUserId="member-a"
    collaboration={{ ...initialCollaborationState, connected: true }}
    online
    onJumpToGantt={() => undefined}
  />
);
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).has("view") ? meetingView : workspace,
);
