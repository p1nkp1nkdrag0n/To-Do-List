import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CollaborationServerMessageSchema,
  type CollaborationClientMessage,
} from "../../shared/realtime-contracts";
import {
  clearTransientCollaborationState,
  initialCollaborationState,
  reduceCollaborationMessage,
  type CollaborationLock,
  type CollaborationPreview,
} from "./collaboration-state";

interface LockWaiter {
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CollaborationClient {
  connected: boolean;
  users: typeof initialCollaborationState.users;
  locks: Record<string, CollaborationLock>;
  previews: Record<string, CollaborationPreview>;
  invalidationVersion: number;
  acquireLock: (participantId: string) => Promise<boolean>;
  heartbeat: (participantId: string) => void;
  preview: (participantId: string, startDate: string, endDate: string) => void;
  release: (participantId: string) => void;
}

function socketUrl(projectId: string): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("projectId", projectId);
  return url.toString();
}

export function useCollaboration(
  projectId: string | undefined,
  currentUserId: string | undefined,
): CollaborationClient {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(initialCollaborationState);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const waitersRef = useRef(new Map<string, LockWaiter>());
  const currentUserIdRef = useRef(currentUserId);
  const lastPreviewAtRef = useRef(0);
  currentUserIdRef.current = currentUserId;

  const resolveWaiters = useCallback((granted: boolean) => {
    for (const waiter of waitersRef.current.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(granted);
    }
    waitersRef.current.clear();
  }, []);

  useEffect(() => {
    setConnected(false);
    setState(initialCollaborationState);
    resolveWaiters(false);
    if (!projectId || !currentUserId) return;

    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== undefined) return;
      const delay = Math.min(5_000, 500 * 2 ** reconnectAttempt);
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      if (!navigator.onLine) {
        scheduleReconnect();
        return;
      }
      const socket = new WebSocket(socketUrl(projectId));
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (stopped || socketRef.current !== socket) return;
        reconnectAttempt = 0;
        setConnected(true);
      });
      socket.addEventListener("message", (event) => {
        if (socketRef.current !== socket) return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = CollaborationServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        const waiter = "participantId" in message
          ? waitersRef.current.get(message.participantId)
          : undefined;
        if (waiter && (message.type === "drag.lock.granted" || message.type === "drag.lock.denied")) {
          clearTimeout(waiter.timer);
          waitersRef.current.delete(message.participantId);
          waiter.resolve(
            message.type === "drag.lock.granted"
              && message.ownerId === currentUserIdRef.current,
          );
        }
        setState((current) => reduceCollaborationMessage(current, message));
      });
      socket.addEventListener("close", () => {
        if (socketRef.current !== socket) return;
        socketRef.current = undefined;
        setConnected(false);
        setState(clearTransientCollaborationState);
        resolveWaiters(false);
        scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    };

    const handleOnline = () => {
      if (socketRef.current === undefined) connect();
    };
    const handleOffline = () => socketRef.current?.close();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      const socket = socketRef.current;
      socketRef.current = undefined;
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Project changed");
      }
      resolveWaiters(false);
    };
  }, [currentUserId, projectId, resolveWaiters]);

  const send = useCallback((message: CollaborationClientMessage): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const acquireLock = useCallback((participantId: string): Promise<boolean> => {
    const existing = waitersRef.current.get(participantId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve(false);
      waitersRef.current.delete(participantId);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitersRef.current.delete(participantId);
        send({ type: "drag.lock.release", participantId });
        resolve(false);
      }, 2_500);
      waitersRef.current.set(participantId, { resolve, timer });
      if (!send({ type: "drag.lock.acquire", participantId })) {
        clearTimeout(timer);
        waitersRef.current.delete(participantId);
        resolve(false);
      }
    });
  }, [send]);

  const heartbeat = useCallback((participantId: string) => {
    send({ type: "drag.lock.heartbeat", participantId });
  }, [send]);

  const preview = useCallback((participantId: string, startDate: string, endDate: string) => {
    const now = performance.now();
    if (now - lastPreviewAtRef.current < 40) return;
    lastPreviewAtRef.current = now;
    send({ type: "drag.preview", participantId, startDate, endDate });
  }, [send]);

  const release = useCallback((participantId: string) => {
    const waiter = waitersRef.current.get(participantId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waitersRef.current.delete(participantId);
      waiter.resolve(false);
    }
    send({ type: "drag.lock.release", participantId });
  }, [send]);

  return useMemo(() => ({
    connected,
    users: state.users,
    locks: state.locks,
    previews: state.previews,
    invalidationVersion: state.invalidationVersion,
    acquireLock,
    heartbeat,
    preview,
    release,
  }), [acquireLock, connected, heartbeat, preview, release, state]);
}
