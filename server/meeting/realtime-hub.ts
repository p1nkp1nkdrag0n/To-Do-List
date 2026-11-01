/**
 * 实时会议转写：浏览器麦克风 → 本服务 → 思必驰实时长语音转写。
 *
 * 为什么要有这一层：
 *  - APIKEY 不能出现在浏览器里；
 *  - 浏览器的 WebSocket 不方便改握手/鉴权；
 *  - 服务端可以按登录用户读取他自己的思必驰配置。
 *
 * 协议（思必驰 Server 接入）：
 *  wss://lasr.duiopen.com/live/ws2?productId=..&apikey=..
 *  client → 文本 start（json）；之后每隔 40ms 发一帧 16k/16bit/单声道 PCM；
 *  最后发一个二进制空帧结束。
 *  服务端 → JSON：errno 7=start ok，8=中间 var，0=中间 rec，9=最后一句。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { parseCookieHeader } from "../http/cookies.js";
import type { V2RuntimeDependencies } from "../http/dependencies.js";
import { AvailabilityService } from "../modules/availability/availability-service.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { readAsrConfig } from "./asr-config.js";

interface ConnectionState {
  connectionId: string;
  userId: string;
  projectId: string | null;
  upstream?: WebSocket;
  closed: boolean;
  pending: Buffer[];
  startedAt: number;
  lastText: string;
  frames: number;
  messages: number;
  dump?: Buffer[];
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class RealtimeAsrHub {
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly authService: AuthService;
  private readonly upgradeHandler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closing = false;

  constructor(
    private readonly server: Server,
    private readonly dependencies: V2RuntimeDependencies,
  ) {
    this.authService = new AuthService(dependencies);
    this.upgradeHandler = (request, socket, head) => this.handleUpgrade(request, socket, head);
    server.on("upgrade", this.upgradeHandler);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.server.off("upgrade", this.upgradeHandler);
    for (const [socket, state] of this.connections) {
      state.closed = true;
      state.upstream?.close();
      socket.terminate();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closing) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    // 别的 WebSocket 入口可能处理这个路径，这里只安静地让出去。
    if (requestUrl.pathname !== "/ws/meeting/realtime") return;
    try {
      const auth = this.authService.authenticate(
        parseCookieHeader(request.headers.cookie).team_session,
      );
      const projectId = requestUrl.searchParams.get("projectId");
      if (projectId !== null) {
        // 只有项目成员能开实时转写，和会议入口的权限保持一致。
        new AvailabilityService(this.dependencies).projectSummary(auth, projectId);
      }
      const state: ConnectionState = {
        connectionId: randomUUID(),
        userId: auth.user.id,
        projectId,
        closed: false,
        pending: [],
        startedAt: Date.now(),
        lastText: "",
        frames: 0,
        messages: 0,
        dump: process.env.REALTIME_DUMP === "1" ? [] : undefined,
      };
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptConnection(webSocket, state);
      });
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
    }
  }

  private acceptConnection(socket: WebSocket, state: ConnectionState): void {
    this.connections.set(socket, state);
    console.log(`[realtime] 新会话 user=${state.userId} project=${state.projectId ?? "-"}`);
    const config = readAsrConfig(state.userId);
    if (config === null) {
      this.send(socket, { type: "error", message: "还没有配置思必驰的 productId / apiKey。" });
      socket.close();
      return;
    }

    // 实时转写通常是另一个产品：优先用 realtime 的那对凭证。
    const realtimeProductId = config.realtimeProductId ?? config.productId;
    const realtimeApiKey = config.realtimeApiKey ?? config.apiKey;
    const url =
      `wss://lasr.duiopen.com/live/ws2?productId=${encodeURIComponent(realtimeProductId)}` +
      `&apikey=${encodeURIComponent(realtimeApiKey)}`;
    const upstream = new WebSocket(url);
    state.upstream = upstream;

    upstream.on("open", () => {
      upstream.send(
        JSON.stringify({
          command: "start",
          params: {
            env: { use_txt_smooth: 1, use_tprocess: 1, use_sensitive_wds_norm: 1 },
            audio: { audioType: "wav", sampleRate: 16000, sampleBytes: 2, channel: 1 },
          },
        }),
      );
    });

    upstream.on("message", (data: RawData) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : data.toString();
      let message: { errno?: number; error?: string; data?: { onebest?: string } };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        return;
      }
      if (message.errno === 7) {
        this.send(socket, { type: "ready" });
        for (const frame of state.pending) upstream.send(frame);
        state.pending = [];
        return;
      }
      const onebest = message.data?.onebest ?? "";
      state.messages += 1;
      // 诊断：前几条结果无论有没有文字都记下来，便于判断服务端是否在解码。
      if (state.messages <= 8) {
        console.log(`[realtime] msg#${state.messages} errno=${String(message.errno)} len=${onebest.length} ${onebest.slice(0, 40)}`);
      }
      if (onebest !== "") state.lastText = onebest;
      if (message.errno === 8) {
        this.send(socket, { type: "partial", text: onebest });
        return;
      }
      if (message.errno === 0) {
        this.send(socket, { type: "partial", text: onebest });
        return;
      }
      if (message.errno === 9) {
        // 最后一句有时 onebest 为空：用最近一次 rec 兜底，避免吞掉收尾文字。
        this.send(socket, { type: "final", text: onebest === "" ? state.lastText : onebest });
        state.lastText = "";
        return;
      }
      this.send(socket, { type: "error", message: `识别服务返回 errno=${String(message.errno)}` });
    });

    upstream.on("error", (error) => {
      console.log(`[realtime] 上游错误：${error.message}`);
      this.send(socket, { type: "error", message: `连接思必驰失败：${error.message}` });
      socket.close();
    });

    upstream.on("close", () => {
      this.send(socket, { type: "status", message: "思必驰连接已关闭" });
      if (!state.closed) socket.close();
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        state.frames += 1;
        if (state.dump !== undefined && state.dump.length < 500) state.dump.push(frame);
        if (state.frames % 100 === 0) {
          console.log(`[realtime] 已收 ${state.frames} 帧（upstream=${upstream.readyState}）`);
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else if (state.pending.length < 200) state.pending.push(frame);
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "stop" && upstream.readyState === WebSocket.OPEN) {
          upstream.send(Buffer.alloc(0));
        }
      } catch {
        // 非 JSON 文本忽略。
      }
    });

    socket.on("close", () => {
      state.closed = true;
      this.connections.delete(socket);
      upstream.close();
      if (state.dump !== undefined && state.dump.length > 0) {
        try {
          const pcm = Buffer.concat(state.dump);
          const header = Buffer.alloc(44);
          header.write("RIFF", 0);
          header.writeUInt32LE(36 + pcm.length, 4);
          header.write("WAVE", 8);
          header.write("fmt ", 12);
          header.writeUInt32LE(16, 16);
          header.writeUInt16LE(1, 20);
          header.writeUInt16LE(1, 22);
          header.writeUInt32LE(16000, 24);
          header.writeUInt32LE(32000, 28);
          header.writeUInt16LE(2, 32);
          header.writeUInt16LE(16, 34);
          header.write("data", 36);
          header.writeUInt32LE(pcm.length, 40);
          const dir = path.join(process.cwd(), ".tmp");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `rt-dump-${Date.now()}.wav`), Buffer.concat([header, pcm]));
          console.log(`[realtime] 已保存音频样本 ${(pcm.length / 32000).toFixed(1)} 秒`);
        } catch (error) {
          console.log("[realtime] 保存音频失败", error);
        }
      }
      console.log(
        `[realtime] 会话结束 user=${state.userId} 时长=${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`,
      );
    });

    socket.on("error", () => {
      state.closed = true;
      upstream.close();
    });
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
}
