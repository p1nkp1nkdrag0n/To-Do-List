import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  CollaborationClientMessageSchema,
  type CollaborationServerMessage,
} from "../../shared/realtime-contracts.js";
import { parseCookieHeader } from "../http/cookies.js";
import type { V2RuntimeDependencies } from "../http/dependencies.js";
import { AuthService, type AuthenticatedSession } from "../modules/auth/auth-service.js";

export interface CollaborationHubOptions {
  lockTtlMs?: number;
  sweepIntervalMs?: number;
  previewThrottleMs?: number;
}

interface ConnectionState {
  connectionId: string;
  projectId: string;
  auth: AuthenticatedSession;
}

interface DragLock {
  projectId: string;
  participantId: string;
  ownerConnectionId: string;
  ownerId: string;
  ownerDisplayName: string;
  expiresAt: number;
  lastPreviewAt: number;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export class CollaborationHub {
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly locks = new Map<string, DragLock>();
  private readonly authService: AuthService;
  private readonly lockTtlMs: number;
  private readonly previewThrottleMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly upgradeHandler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closing = false;

  constructor(
    private readonly server: Server,
    private readonly dependencies: V2RuntimeDependencies,
    options: CollaborationHubOptions = {},
  ) {
    this.authService = new AuthService(dependencies);
    this.lockTtlMs = options.lockTtlMs ?? 15_000;
    this.previewThrottleMs = options.previewThrottleMs ?? 50;
    const sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
    this.upgradeHandler = (request, socket, head) => this.handleUpgrade(request, socket, head);
    server.on("upgrade", this.upgradeHandler);
    this.sweepTimer = setInterval(() => this.expireLocks(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  publishEntityInvalidation(
    projectId: string,
    entityType: "project" | "task" | "participant" | "resource" | "availability",
    entityId: string,
  ): void {
    this.broadcast(projectId, { type: "entity.invalidated", entityType, entityId });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.sweepTimer);
    this.server.off("upgrade", this.upgradeHandler);
    for (const socket of this.connections.keys()) socket.terminate();
    this.connections.clear();
    this.locks.clear();
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
    if (requestUrl.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    try {
      const projectId = requestUrl.searchParams.get("projectId");
      if (projectId === null) {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      const auth = this.authService.authenticate(
        parseCookieHeader(request.headers.cookie).team_session,
      );
      if (!this.isActiveProjectMember(projectId, auth.user.id)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const state: ConnectionState = {
        connectionId: randomUUID(),
        projectId,
        auth,
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
    socket.on("message", (raw) => this.handleMessage(socket, state, raw));
    socket.on("close", () => this.disconnect(socket, state));
    socket.on("error", () => undefined);
    this.broadcastPresence(state.projectId);
  }

  private handleMessage(socket: WebSocket, state: ConnectionState, raw: RawData): void {
    let input: unknown;
    try {
      input = JSON.parse(raw.toString());
    } catch {
      socket.close(1008, "Invalid message");
      return;
    }
    const parsed = CollaborationClientMessageSchema.safeParse(input);
    if (!parsed.success) {
      socket.close(1008, "Invalid message");
      return;
    }
    if (!this.isActiveProjectMember(state.projectId, state.auth.user.id)) {
      socket.close(1008, "Project access revoked");
      return;
    }
    const message = parsed.data;
    if (!this.participantExists(state.projectId, message.participantId)) {
      socket.close(1008, "Participant not found");
      return;
    }
    switch (message.type) {
      case "drag.lock.acquire":
        this.acquireLock(socket, state, message.participantId);
        break;
      case "drag.lock.heartbeat":
        this.heartbeat(state, message.participantId);
        break;
      case "drag.preview":
        this.preview(state, message.participantId, message.startDate, message.endDate);
        break;
      case "drag.lock.release":
        this.releaseOwnedLock(state, message.participantId, "released");
        break;
    }
  }

  private participantExists(projectId: string, participantId: string): boolean {
    return this.dependencies.database.get(
      `SELECT task_participants.id FROM task_participants
        JOIN tasks ON tasks.id=task_participants.task_id
       WHERE task_participants.id=? AND task_participants.project_id=?
         AND task_participants.removed_at IS NULL
         AND tasks.deleted_at IS NULL AND tasks.archived_at IS NULL`,
      [participantId, projectId],
    ) !== undefined;
  }

  private isActiveProjectMember(projectId: string, userId: string): boolean {
    return this.dependencies.database.get(
      `SELECT projects.id FROM projects
        JOIN project_members ON project_members.project_id=projects.id
        JOIN team_members ON team_members.user_id=project_members.user_id
        JOIN users ON users.id=project_members.user_id
       WHERE projects.id=? AND project_members.user_id=?
         AND projects.deleted_at IS NULL
         AND project_members.removed_at IS NULL
         AND team_members.removed_at IS NULL
         AND users.disabled_at IS NULL`,
      [projectId, userId],
    ) !== undefined;
  }

  private acquireLock(socket: WebSocket, state: ConnectionState, participantId: string): void {
    const key = this.lockKey(state.projectId, participantId);
    const now = Date.now();
    const current = this.locks.get(key);
    if (current !== undefined && current.expiresAt > now && current.ownerConnectionId !== state.connectionId) {
      this.send(socket, {
        type: "drag.lock.denied",
        participantId,
        ownerId: current.ownerId,
        ownerDisplayName: current.ownerDisplayName,
        expiresAt: new Date(current.expiresAt).toISOString(),
      });
      return;
    }
    const lock: DragLock = {
      projectId: state.projectId,
      participantId,
      ownerConnectionId: state.connectionId,
      ownerId: state.auth.user.id,
      ownerDisplayName: state.auth.user.displayName,
      expiresAt: now + this.lockTtlMs,
      lastPreviewAt: 0,
    };
    this.locks.set(key, lock);
    this.broadcast(state.projectId, {
      type: "drag.lock.granted",
      participantId,
      ownerId: lock.ownerId,
      ownerDisplayName: lock.ownerDisplayName,
      expiresAt: new Date(lock.expiresAt).toISOString(),
    });
  }

  private heartbeat(state: ConnectionState, participantId: string): void {
    const lock = this.locks.get(this.lockKey(state.projectId, participantId));
    if (lock?.ownerConnectionId === state.connectionId) {
      lock.expiresAt = Date.now() + this.lockTtlMs;
    }
  }

  private preview(
    state: ConnectionState,
    participantId: string,
    startDate: string,
    endDate: string,
  ): void {
    const lock = this.locks.get(this.lockKey(state.projectId, participantId));
    const now = Date.now();
    if (lock?.ownerConnectionId !== state.connectionId || lock.expiresAt <= now) return;
    if (now - lock.lastPreviewAt < this.previewThrottleMs) return;
    lock.lastPreviewAt = now;
    lock.expiresAt = now + this.lockTtlMs;
    this.broadcast(state.projectId, {
      type: "drag.preview",
      participantId,
      ownerId: lock.ownerId,
      ownerDisplayName: lock.ownerDisplayName,
      startDate,
      endDate,
    });
  }

  private releaseOwnedLock(
    state: ConnectionState,
    participantId: string,
    reason: "released" | "disconnected" | "expired",
  ): void {
    const key = this.lockKey(state.projectId, participantId);
    const lock = this.locks.get(key);
    if (lock?.ownerConnectionId !== state.connectionId) return;
    this.locks.delete(key);
    this.broadcast(state.projectId, { type: "drag.lock.released", participantId, reason });
  }

  private disconnect(socket: WebSocket, state: ConnectionState): void {
    this.connections.delete(socket);
    for (const lock of [...this.locks.values()]) {
      if (lock.ownerConnectionId === state.connectionId) {
        this.releaseOwnedLock(state, lock.participantId, "disconnected");
      }
    }
    this.broadcastPresence(state.projectId);
  }

  private expireLocks(): void {
    const now = Date.now();
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt > now) continue;
      this.locks.delete(key);
      this.broadcast(lock.projectId, {
        type: "drag.lock.released",
        participantId: lock.participantId,
        reason: "expired",
      });
    }
  }

  private broadcastPresence(projectId: string): void {
    const users = new Map<string, { userId: string; displayName: string; connectionCount: number }>();
    for (const state of this.connections.values()) {
      if (state.projectId !== projectId) continue;
      const current = users.get(state.auth.user.id);
      if (current) current.connectionCount += 1;
      else users.set(state.auth.user.id, {
        userId: state.auth.user.id,
        displayName: state.auth.user.displayName,
        connectionCount: 1,
      });
    }
    this.broadcast(projectId, { type: "presence", projectId, users: [...users.values()] });
  }

  private broadcast(projectId: string, message: CollaborationServerMessage): void {
    for (const [socket, state] of this.connections) {
      if (state.projectId !== projectId) continue;
      if (!this.isActiveProjectMember(projectId, state.auth.user.id)) {
        socket.close(1008, "Project access revoked");
        continue;
      }
      this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: CollaborationServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private lockKey(projectId: string, participantId: string): string {
    return `${projectId}:${participantId}`;
  }
}
