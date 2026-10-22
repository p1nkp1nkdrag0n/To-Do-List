/**
 * 会议页的后端入口：一个 POST 就启动整条自动化链路。
 *
 *   POST /api/meeting/run  { projectId }
 *
 * 返回本次运行的事件流（同步等流程跑完，演示只有几秒）；
 * 同时每个事件都会通过 ws 推给同一个项目的浏览器，前端据此滚动日志。
 */
import { Router, type Response } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { V2RuntimeDependencies } from "../http/dependencies.js";
import { parseRequestBody } from "../http/routing.js";
import { HttpError } from "../http/errors.js";
import { AvailabilityService } from "../modules/availability/availability-service.js";
import type { AuthLocals } from "../modules/auth/auth-router.js";
import { MeetingOrchestrator } from "./orchestrator.js";

import express from "express";

import { MeetingControl } from "./control.js";
import { parseMinutesFile } from "./minutes-file.js";
import { clearProjectSchedule } from "./demo-reset.js";
import { undoPlan } from "./undo.js";
import type { AppliedPlanRecord } from "./events.js";

const RunMeetingRequestSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

/** 纪要路径：带 minutes 就从纪要抽任务，不带就是老的「只修复」路径。 */
const RunWithMinutesSchema = z
  .object({
    projectId: z.string().min(1),
    minutes: z.string().max(20_000).optional(),
    lockOwners: z.boolean().optional(),
    replaceSchedule: z.boolean().optional(),
  })
  .strict();

const ResetRequestSchema = z
  .object({
    projectId: z.string().min(1),
    mode: z.enum(["seed", "empty"]).default("seed"),
  })
  .strict();

/**
 * 撤销记录落一个小文件，服务重启后仍然可撤销。
 * 放 data/ 下（已被 .gitignore 排除），不进数据库，免得为演示加迁移。
 */
const LAST_PLAN_FILE = path.join(process.cwd(), "data", "v2", "meeting-last-plan.json");

function loadLastApplied(): Map<string, AppliedPlanRecord> {
  try {
    const raw = fs.readFileSync(LAST_PLAN_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, AppliedPlanRecord>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveLastApplied(plans: Map<string, AppliedPlanRecord>): void {
  try {
    fs.mkdirSync(path.dirname(LAST_PLAN_FILE), { recursive: true });
    fs.writeFileSync(LAST_PLAN_FILE, JSON.stringify(Object.fromEntries(plans), null, 2));
  } catch {
    // 落盘失败不影响主流程，最坏情况就是重启后不能撤销。
  }
}

export function createMeetingRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const availability = new AvailabilityService(dependencies);
  /** 每个项目最近一次自动应用的方案，撤销时反推用。 */
  const lastApplied = loadLastApplied();
  /** 正在运行的会议处理，按项目存一份暂停开关。 */
  const controls = new Map<string, MeetingControl>();

  router.post(
    "/run",
    async (request, response: Response<unknown, AuthLocals>) => {
      const { projectId, minutes, lockOwners, replaceSchedule } = parseRequestBody(
        RunWithMinutesSchema,
        request,
      );
      const auth = response.locals.auth;

      // 只有项目成员能触发；编排器本身用 MCP 的固定身份跑，但入口必须先过权限。
      try {
        availability.projectSummary(auth, projectId);
      } catch {
        throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
      }

      const control = new MeetingControl();
      controls.set(projectId, control);
      const orchestrator = new MeetingOrchestrator({
        projectId,
        control,
        // 演示节奏：让「红 → 绿」有个看得见的停顿；设成 0 可以关掉。
        paceMs: Number(process.env.MEETING_PACE_MS ?? 1200),
        lockOwners: lockOwners ?? false,
        onEvent(event) {
          dependencies.publishMeetingEvent?.(projectId, {
            type: event.type,
            at: event.at,
            message: event.message,
            detail:
              event.type === "tool.call"
                ? {
                    tool: event.tool,
                    status: event.status,
                    argumentsSummary: event.argumentsSummary,
                    resultSummary: event.resultSummary,
                    durationMs: event.durationMs,
                  }
                : event.detail,
          });
        },
        onDataChanged(changedProjectId) {
          dependencies.publishEntityInvalidation?.(changedProjectId, "project", changedProjectId);
          dependencies.publishEntityInvalidation?.(changedProjectId, "task", changedProjectId);
        },
      });

      const trimmed = minutes?.trim() ?? "";
      let clearedTasks = 0;
      if (trimmed !== "" && replaceSchedule === true) {
        // 从纪要建排期＝重建，不是往旧排期上叠加。
        clearedTasks = clearProjectSchedule(dependencies, projectId).removedTasks;
        dependencies.publishMeetingEvent?.(projectId, {
          type: "session.started",
          at: new Date().toISOString(),
          message:
            clearedTasks > 0
              ? `已清空原有排期（${clearedTasks} 个任务），按纪要重建`
              : "当前排期为空，按纪要新建",
        });
      }
      let result;
      try {
        result =
          trimmed === ""
            ? await orchestrator.run()
            : await orchestrator.runFromMinutes(trimmed);
      } finally {
        controls.delete(projectId);
      }
      if (result.appliedPlan !== null) {
        lastApplied.set(projectId, result.appliedPlan);
        saveLastApplied(lastApplied);
      }
      response.json({
        projectId: result.projectId,
        conflictsBefore: result.conflictsBefore,
        conflictsAfter: result.conflictsAfter,
        appliedPlanId: result.appliedPlanId,
        clearedTasks,
        undoAvailable: lastApplied.has(projectId),
        durationMs: result.durationMs,
        events: result.events,
      });
    },
  );

  /**
   * 上传纪要文件（txt / docx / pdf），返回抽好的纯文本。
   * 用一个原始 body + 文件名 header，避免引入 multipart 依赖。
   */
  router.post(
    "/minutes",
    express.raw({ type: "*/*", limit: "20mb" }),
    async (request, response: Response<unknown, AuthLocals>) => {
      const rawName = String(request.headers["x-filename"] ?? "minutes.txt");
      let filename = rawName;
      try {
        filename = decodeURIComponent(rawName);
      } catch {
        // 文件名没编码过，按原样用。
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new HttpError(400, "EMPTY_FILE", "没有收到文件内容。");
      }
      const parsed = await parseMinutesFile(filename, body);
      response.json({ filename: parsed.filename, chars: parsed.chars, text: parsed.text });
    },
  );

  /** 暂停 / 继续：只在会议处理跑到一半时有意义。 */
  router.post(
    "/control",
    (request, response: Response<unknown, AuthLocals>) => {
      const { projectId, action } = parseRequestBody(
        z.object({ projectId: z.string().min(1), action: z.enum(["pause", "resume"]) }).strict(),
        request,
      );
      const control = controls.get(projectId);
      if (control === undefined) {
        throw new HttpError(409, "NO_RUNNING_MEETING", "当前没有正在处理的会议。");
      }
      if (action === "pause") control.pause();
      else control.resume();
      dependencies.publishMeetingEvent?.(projectId, {
        type: "session.started",
        at: new Date().toISOString(),
        message: action === "pause" ? "已请求暂停，将在下一个检查点停下" : "已恢复",
        detail: { paused: action === "pause" },
      });
      response.json({ projectId, paused: control.isPaused });
    },
  );

  /** 页面刷新后也要知道「有没有可撤销的调整」，所以单独给一个查询入口。 */
  router.get(
    "/status",
    (request, response: Response<unknown, AuthLocals>) => {
      const projectId = String(request.query.projectId ?? "");
      if (projectId === "") {
        throw new HttpError(400, "PROJECT_REQUIRED", "projectId 不能为空。");
      }
      const plan = lastApplied.get(projectId);
      response.json({
        projectId,
        undoAvailable: plan !== undefined,
        appliedPlanId: plan?.id ?? null,
        appliedPlanLabel: plan?.label ?? null,
      });
    },
  );

  /** 撤销上一次自动应用 —— 人在环上的入口，不参与默认流程。 */
  router.post(
    "/undo",
    (request, response: Response<unknown, AuthLocals>) => {
      const { projectId } = parseRequestBody(RunMeetingRequestSchema, request);
      const plan = lastApplied.get(projectId);
      if (plan === undefined) {
        throw new HttpError(
          409,
          "NOTHING_TO_UNDO",
          "没有可撤销的自动调整（进程重启后会丢失撤销记录）。",
        );
      }
      const result = undoPlan(dependencies, response.locals.auth, projectId, plan);
      lastApplied.delete(projectId);
      saveLastApplied(lastApplied);
      dependencies.publishEntityInvalidation?.(projectId, "project", projectId);
      dependencies.publishEntityInvalidation?.(projectId, "task", projectId);
      response.json(result);
    },
  );

  /** 还原演示数据（现场保险）：本质上是跑一遍 seed 脚本 --reset。 */
  router.post(
    "/reset",
    async (request, response: Response<unknown, AuthLocals>) => {
      const { projectId, mode } = parseRequestBody(ResetRequestSchema, request);
      try {
        availability.projectSummary(response.locals.auth, projectId);
      } catch {
        throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
      }

      // 「清空任务」：只清本项目排期，成员和可用时间保留，用于接会议纪要。
      if (mode === "empty") {
        const cleared = clearProjectSchedule(dependencies, projectId);
        lastApplied.delete(projectId);
        saveLastApplied(lastApplied);
        dependencies.publishEntityInvalidation?.(projectId, "project", projectId);
        dependencies.publishEntityInvalidation?.(projectId, "task", projectId);
        response.json({
          ok: true,
          mode,
          removedTasks: cleared.removedTasks,
          tail: [`已清空 ${cleared.removedTasks} 个任务`],
        });
        return;
      }

      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/seed-demo-v3.ts", "--reset"],
        { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      const code: number = await new Promise((resolve) => {
        child.on("close", (exitCode) => resolve(exitCode ?? 1));
      });

      lastApplied.delete(projectId);
      saveLastApplied(lastApplied);
      dependencies.publishEntityInvalidation?.(projectId, "project", projectId);
      dependencies.publishEntityInvalidation?.(projectId, "task", projectId);

      response.json({
        ok: code === 0,
        exitCode: code,
        tail: output.trim().split("\n").slice(-6),
      });
    },
  );

  return router;
}
