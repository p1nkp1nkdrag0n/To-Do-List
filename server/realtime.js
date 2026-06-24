import { WebSocketServer } from "ws";
import { verifyToken } from "./security.js";

export function createRealtime(server, db) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map();

  wss.on("connection", (socket) => {
    clients.set(socket, { userId: null, projects: new Set() });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "subscribe") {
          const token = verifyToken(message.token);
          if (!token) {
            socket.send(JSON.stringify({ type: "auth:error" }));
            return;
          }
          const member = db.get(
            "SELECT project_id FROM project_members WHERE project_id = ? AND user_id = ?",
            [message.projectId, token.userId]
          );
          if (!member) {
            socket.send(JSON.stringify({ type: "subscribe:denied", projectId: message.projectId }));
            return;
          }
          clients.set(socket, {
            userId: token.userId,
            projects: new Set([...(clients.get(socket)?.projects || []), message.projectId])
          });
          socket.send(JSON.stringify({ type: "subscribe:ok", projectId: message.projectId }));
        }
      } catch {
        socket.send(JSON.stringify({ type: "message:error" }));
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  return {
    broadcastProject(projectId, reason = "project:update") {
      const message = JSON.stringify({ type: "project:update", projectId, reason });
      for (const [socket, meta] of clients.entries()) {
        if (socket.readyState === socket.OPEN && meta.projects.has(projectId)) {
          socket.send(message);
        }
      }
    },
    broadcastUser(userId, reason = "personal:update") {
      const message = JSON.stringify({ type: "personal:update", reason });
      for (const [socket, meta] of clients.entries()) {
        if (socket.readyState === socket.OPEN && meta.userId === userId) {
          socket.send(message);
        }
      }
    }
  };
}
