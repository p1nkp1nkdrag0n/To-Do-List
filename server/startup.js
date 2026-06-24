import http from "node:http";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";
import { createApp } from "./app.js";
import { createRealtime } from "./realtime.js";

export const defaultDistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");

export function defaultHost(env = process.env) {
  return env.HOST || (env.NODE_ENV === "production" ? "127.0.0.1" : undefined);
}

export function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const missing = [];
  if (!env.AUTH_SECRET) {
    missing.push("AUTH_SECRET");
  }
  if (!env.BOOTSTRAP_CODE) {
    missing.push("BOOTSTRAP_CODE");
  }
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}.`);
  }
}

export function attachFrontend(app, distPath = defaultDistPath) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(distPath, "index.html"), (error) => {
      if (error) {
        res.status(404).send("Build the frontend with npm run build, or use npm run dev.");
      }
    });
  });
}

export function createHttpServer(db, { distPath = defaultDistPath } = {}) {
  const server = http.createServer();
  const realtime = createRealtime(server, db);
  const app = createApp(db, realtime);
  attachFrontend(app, distPath);
  server.on("request", app);
  return { app, realtime, server };
}

export async function startServer({
  port = Number(process.env.PORT || 4000),
  host = defaultHost(),
  db,
  distPath = defaultDistPath
} = {}) {
  validateProductionConfig();
  const database = db || await createDatabase();
  const serverParts = createHttpServer(database, { distPath });
  await new Promise((resolve, reject) => {
    serverParts.server.once("error", reject);
    const onListen = () => {
      serverParts.server.off("error", reject);
      resolve();
    };
    if (host) {
      serverParts.server.listen(port, host, onListen);
    } else {
      serverParts.server.listen(port, onListen);
    }
  });
  const address = serverParts.server.address();
  return {
    ...serverParts,
    db: database,
    host: typeof address === "object" && address ? address.address : host,
    port: typeof address === "object" && address ? address.port : port
  };
}
