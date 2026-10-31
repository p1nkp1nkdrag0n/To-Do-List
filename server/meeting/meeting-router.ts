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

import { randomUUID } from "node:crypto";

import express from "express";

import { asyncRoute } from "../http/routing.js";

import { MeetingControl } from "./control.js";
import { asrConfigView, readAsrConfig, writeAsrConfig, AsrConfigSchema } from "./asr-config.js";
import { AsrError, audioFormatFor, createAudio, transcribeAudio } from "./asr.js";
import { correctTranscript } from "./asr-correct.js";
import { extractTasksFromText } from "./extractor.js";
import { generateMinutes } from "./summary.js";
import { ResourceService } from "../modules/resources/resource-service.js";
import { chatJson } from "./llm.js";
import {
  activateProvider,
  configView,
  createProvider,
  deleteProvider,
  readConfig,
  updateProvider,
} from "./llm-config.js";
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
const DraftTasksSchema = z.object({
  projectId: z.string().min(1),
  minutes: z.string().min(1).max(200_000),
});

const SummarySchema = z.object({
  projectId: z.string().min(1),
  transcript: z.string().min(1).max(200_000),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(60),
        ownerName: z.string().min(1).max(40),
        estimatedHours: z.number().positive().max(200),
        dueDate: z.string().nullable().optional(),
      }),
    )
    .max(60)
    .optional(),
  save: z.boolean().optional(),
});

const CorrectTextSchema = z.object({
  text: z.string().min(1).max(200_000),
  hotwords: z.array(z.string().min(1).max(40)).max(200).optional(),
});

const RunWithMinutesSchema = z
  .object({
    projectId: z.string().min(1),
    // 与 draft/correct/summary 保持一致：长会议转写可能超过 2 万字。
    minutes: z.string().max(200_000).optional(),
    lockOwners: z.boolean().optional(),
    replaceSchedule: z.boolean().optional(),
    // 确认面板确认过的任务：有这份清单就不再重新抽取。
    tasks: z
      .array(
        z.object({
          clientTaskId: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(60),
          ownerName: z.string().min(1),
          ownerUserId: z.string().min(1).nullable().optional(),
          estimatedHours: z.number().positive().max(200),
          dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          dependsOnTitle: z.string().max(60).nullish(),
          predecessorClientTaskIds: z.array(z.string().min(1).max(120)).max(60).optional(),
        }),
      )
      .max(60)
      .optional(),
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

interface AsrJob {
  /** 任务归属：只有创建者本人能读取结果。 */
  userId: string;
  projectId?: string;
  status: "running" | "done" | "error";
  progress: number;
  note: string;
  text?: string;
  segments?: Array<{ startMs: number; endMs: number; text: string; speaker: number | null }>;
  durationMs?: number;
  createdAt: number;
}

/** 转写任务放在内存里即可：进程重启后用户可以重新上传。 */
const asrJobs = new Map<string, AsrJob>();
const ASR_JOB_TTL_MS = 60 * 60 * 1000;

function pruneAsrJobs(): void {
  const now = Date.now();
  for (const [id, job] of asrJobs) {
    if (now - job.createdAt > ASR_JOB_TTL_MS) asrJobs.delete(id);
  }
}

export function createMeetingRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const availability = new AvailabilityService(dependencies);
  /** 每个项目最近一次自动应用的方案，撤销时反推用。 */
  const lastApplied = loadLastApplied();

  /** 所有按项目操作的接口都必须先确认调用者是项目成员。 */
  const assertMember = (auth: AuthLocals["auth"], projectId: string): void => {
    try {
      availability.projectSummary(auth, projectId);
    } catch {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
  };
  /** 正在运行的会议处理，按项目存一份暂停开关。 */
  const controls = new Map<string, MeetingControl>();

  router.post(
    "/run",
    asyncRoute(async (request, response) => {
      const { projectId, minutes, lockOwners, replaceSchedule, tasks } = parseRequestBody(
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

      if (controls.has(projectId)) {
        throw new HttpError(409, "MEETING_BUSY", "这个项目已经有一轮在处理了，等它跑完再试。");
      }
      const scheduleRow = dependencies.database.get<{ schedule_revision: number }>(
        "SELECT schedule_revision FROM projects WHERE id = ? AND deleted_at IS NULL",
        [projectId],
      );
      const control = new MeetingControl();
      controls.set(projectId, control);
      const orchestratorOptions: ConstructorParameters<typeof MeetingOrchestrator>[0] = {
        projectId,
        confirmedTasks: tasks,
        expectedScheduleRevision: scheduleRow?.schedule_revision,
        replaceSchedule: replaceSchedule === true,
        control,
        // 演示节奏：让「红 → 绿」有个看得见的停顿；设成 0 可以关掉。
        paceMs: Number(process.env.MEETING_PACE_MS ?? 1200),
        lockOwners: lockOwners ?? false,
        actingUserId: auth.user.id,
        actingUserName: auth.user.username,
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
      };
      const orchestrator = new MeetingOrchestrator(orchestratorOptions);

      const trimmed = minutes?.trim() ?? "";
      let clearedTasks = 0;
      // 「按纪要重建」的清理交给编排器：只有纪要解析成功、任务即将创建时才删旧排期。
      // 解析失败会直接抛错，旧排期原样保留。
      const clearOnSuccess =
        trimmed !== "" && replaceSchedule === true
          ? () => {
              clearedTasks = clearProjectSchedule(dependencies, projectId).removedTasks;
              return clearedTasks;
            }
          : undefined;
      if (clearOnSuccess !== undefined) {
        orchestratorOptions.beforeCreateTasks = clearOnSuccess;
      }
      let result;
      try {
        result =
          trimmed === "" && (tasks === undefined || tasks.length === 0)
            ? await orchestrator.run()
            : await orchestrator.runFromMinutes(trimmed);
      } catch (error) {
        // 编排器抛的是普通 Error，这里转成 400，页面才能显示真实原因。
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          400,
          "MEETING_RUN_FAILED",
          error instanceof Error ? error.message : String(error),
        );
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
        warnings: result.warnings,
        events: result.events,
      });
    }),
  );

  /** 语音转写：读/存思必驰的 productId + apiKey（每个用户一份）。 */
  router.get("/asr-config", (_request, response) => {
    response.json(asrConfigView(readAsrConfig(response.locals.auth.user.id)));
  });

  /** 导出给别人用的分享串（仅导出自己的配置）。 */
  router.get("/asr-config/export", (_request, response) => {
    const config = readAsrConfig(response.locals.auth.user.id);
    if (config === null) {
      throw new HttpError(409, "ASR_NOT_CONFIGURED", "还没有可分享的思必驰配置。");
    }
    response.json({ share: `asr://${config.productId}:${config.apiKey}` });
  });

  router.put("/asr-config", (request, response) => {
    const input = parseRequestBody(
      z
        .object({
          productId: z.string().trim().min(1).max(64),
          apiKey: z.string().trim().max(200).optional(),
          realtimeProductId: z.string().trim().max(64).optional(),
          realtimeApiKey: z.string().trim().max(200).optional(),
        })
        .strict(),
      request,
    );
    const userId = response.locals.auth.user.id;
    const existing = readAsrConfig(userId);
    const apiKey = input.apiKey !== undefined && input.apiKey !== "" ? input.apiKey : existing?.apiKey;
    if (apiKey === undefined || apiKey === "") {
      throw new HttpError(400, "ASR_KEY_REQUIRED", "第一次配置需要填 apiKey。");
    }
    const realtimeApiKey =
      input.realtimeApiKey !== undefined && input.realtimeApiKey !== ""
        ? input.realtimeApiKey
        : existing?.realtimeApiKey;
    const realtimeProductId =
      input.realtimeProductId !== undefined && input.realtimeProductId !== ""
        ? input.realtimeProductId
        : existing?.realtimeProductId;
    writeAsrConfig(
      userId,
      AsrConfigSchema.parse({
        version: 1,
        productId: input.productId,
        apiKey,
        ...(realtimeProductId !== undefined && realtimeApiKey !== undefined
          ? { realtimeProductId, realtimeApiKey }
          : {}),
      }),
    );
    response.json(asrConfigView(readAsrConfig(userId)));
  });

  /** 实时会议：边听边拟任务（只读，不写库）。 */
  router.post("/draft", asyncRoute(async (request, response) => {
    const { projectId, minutes } = parseRequestBody(DraftTasksSchema, request);
    const auth = response.locals.auth;
    new AvailabilityService(dependencies).projectSummary(auth, projectId);
    const names = dependencies.database
      .prepare(
        `SELECT users.display_name AS displayName
           FROM project_members
           JOIN users ON users.id = project_members.user_id
          WHERE project_members.project_id = ? AND project_members.removed_at IS NULL`,
      )
      .all(projectId) as Array<{ displayName: string }>;
    const memberNames = names.map((member) => member.displayName);
    // 实时识别容易把名字听成同音字，先按成员名校正再抽任务。
    const corrected = await correctTranscript({
      userId: auth.user.id,
      text: minutes,
      hotwords: memberNames,
    });
    const extraction = await extractTasksFromText(corrected, memberNames, auth.user.id);
    response.json({ tasks: extraction.tasks, warnings: extraction.warnings });
  }));

  /** 生成会议纪要，并（默认）存档到资料库。 */
  router.post("/summary", asyncRoute(async (request, response) => {
    const { projectId, transcript, tasks, save } = parseRequestBody(SummarySchema, request);
    const auth = response.locals.auth;
    new AvailabilityService(dependencies).projectSummary(auth, projectId);

    const now = new Date();
    const stamp = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(now)
      .replace(/\//g, "-");
    const title = `会议纪要 ${stamp}`;

    const markdown = await generateMinutes({
      userId: auth.user.id,
      transcript,
      tasks,
      title,
    });

    let resourceId: string | null = null;
    if (save !== false) {
      const resources = new ResourceService(dependencies);
      const created = resources.create(
        auth,
        projectId,
        { kind: "markdown", title, markdownContent: markdown },
        undefined,
      );
      resourceId = created.resource.id;
    }
    response.json({ title, markdown, resourceId });
  }));

  /** 实时转写没有热词参数：拿到文本后按项目成员名做一次同音字校正。 */
  router.post("/correct", asyncRoute(async (request, response) => {
    const { text, hotwords } = parseRequestBody(CorrectTextSchema, request);
    const corrected = await correctTranscript({
      userId: response.locals.auth.user.id,
      text,
      hotwords,
    });
    response.json({ text: corrected });
  }));

  /** 测试凭证：只创建音频（不建任务、不计费），能验证 Key 和 IP 白名单。 */
  router.post("/asr-config/test", asyncRoute(async (_request, response) => {
    const config = readAsrConfig(response.locals.auth.user.id);
    if (config === null) {
      throw new HttpError(409, "ASR_NOT_CONFIGURED", "还没有配置思必驰的 productId / apiKey。");
    }
    try {
      await createAudio(config, { audioType: "mp3", sliceCount: 1 });
      response.json({
        ok: true,
        note: "鉴权通过。额度是否充足要等真正转写时才知道。",
      });
    } catch (error) {
      const message = error instanceof AsrError ? error.message : error instanceof Error ? error.message : String(error);
      throw new HttpError(400, "ASR_TEST_FAILED", message);
    }
  }));

  /** 上传音频，后台转写；前端轮询下面的状态接口。 */
  router.post(
    "/transcribe",
    express.raw({ type: "*/*", limit: "200mb" }),
    asyncRoute(async (request, response) => {
      const config = readAsrConfig(response.locals.auth.user.id);
      if (config === null) {
        throw new HttpError(409, "ASR_NOT_CONFIGURED", "还没有配置思必驰的 productId / apiKey。");
      }
      let filename = String(request.headers["x-filename"] ?? "audio.mp3");
      try {
        filename = decodeURIComponent(filename);
      } catch {
        // 文件名没编码过，按原样用。
      }
      if (audioFormatFor(filename) === null) {
        throw new HttpError(400, "ASR_FORMAT", "不支持的音频格式：请用 mp3 / wav / m4a / aac / ogg。");
      }
      const audio = request.body;
      let hotwords: string[] = [];
      const rawHotwords = request.headers["x-hotwords"];
      if (typeof rawHotwords === "string" && rawHotwords !== "") {
        try {
          const parsed = JSON.parse(decodeURIComponent(rawHotwords)) as unknown;
          if (Array.isArray(parsed)) {
            hotwords = parsed.filter((item): item is string => typeof item === "string").slice(0, 200);
          }
        } catch {
          // 热词格式不对就忽略，不影响转写。
        }
      }
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        throw new HttpError(400, "EMPTY_FILE", "没有收到音频内容。");
      }

      const rawProjectId = request.headers["x-project-id"];
      let projectId: string | undefined;
      if (typeof rawProjectId === "string" && rawProjectId !== "") {
        // 带项目时先校验成员身份；失败直接拒绝，不创建任务。
        new AvailabilityService(dependencies).projectSummary(response.locals.auth, rawProjectId);
        projectId = rawProjectId;
      }

      const jobId = randomUUID();
      asrJobs.set(jobId, {
        userId: response.locals.auth.user.id,
        ...(projectId !== undefined ? { projectId } : {}),
        status: "running",
        progress: 0,
        note: "准备上传",
        createdAt: Date.now(),
      });
      void transcribeAudio({
        config,
        filename,
        audio,
        hotwords,
        onProgress: (progress, note) => {
          const job = asrJobs.get(jobId);
          if (job !== undefined) Object.assign(job, { progress, note });
        },
      })
        .then(async (transcript) => {
          // 用大模型按热词校正同音字；没有配置大模型或失败时保留原文。
          const job = asrJobs.get(jobId);
          if (job !== undefined) Object.assign(job, { progress: 99, note: "校对转写文本" });
          const corrected = await correctTranscript({
            userId: response.locals.auth.user.id,
            text: transcript.text,
            hotwords,
          });
          const finished = asrJobs.get(jobId);
          if (finished !== undefined) {
            Object.assign(finished, {
              status: "done",
              progress: 100,
              note: "转写完成",
              text: corrected,
              segments: transcript.segments,
              durationMs: transcript.durationMs,
            });
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof AsrError ? error.message : error instanceof Error ? error.message : String(error);
          const failed = asrJobs.get(jobId);
          if (failed !== undefined) Object.assign(failed, { status: "error", progress: 0, note: message });
        });

      response.status(202).json({ jobId });
    }),
  );

  router.get("/transcribe/:jobId", (request, response) => {
    pruneAsrJobs();
    const job = asrJobs.get(request.params.jobId);
    // 归属不符时返回 404，而不是 403：避免暴露“这个 jobId 存在”。
    if (job === undefined || job.userId !== response.locals.auth.user.id) {
      throw new HttpError(404, "ASR_JOB_NOT_FOUND", "找不到这个转写任务。");
    }
    response.json(job);
  });

  /**
   * 上传纪要文件（txt / docx / pdf），返回抽好的纯文本。
   * 用一个原始 body + 文件名 header，避免引入 multipart 依赖。
   */
  router.post(
    "/minutes",
    // 纪要文件一般不到 1MB；给到 10MB 足够，也避免解压/解析把内存打满。
    express.raw({ type: "*/*", limit: "10mb" }),
    asyncRoute(async (request, response) => {
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
      let parsed;
      try {
        parsed = await parseMinutesFile(filename, body);
      } catch (error) {
        throw new HttpError(
          400,
          "MINUTES_PARSE_FAILED",
          error instanceof Error ? error.message : "文件解析失败。",
        );
      }
      response.json({ filename: parsed.filename, chars: parsed.chars, text: parsed.text });
    }),
  );

  /** 读全部供应商（key 只回显末四位，外加“当前是哪个”）。 */
  router.get("/llm-config", (_request, response) => {
    response.json(configView(response.locals.auth.user.id));
  });

  /** 新增一个供应商；第一个自动设为当前。 */
  router.post("/llm/providers", (request, response) => {
    const input = parseRequestBody(
      z
        .object({
          name: z.string().min(1).max(40),
          baseUrl: z.string().url(),
          model: z.string().min(1).max(80),
          apiKey: z.string().max(200),
        })
        .strict(),
      request,
    );
    const created = createProvider(response.locals.auth.user.id, input);
    response.status(201).json({ id: created.id, ...configView(response.locals.auth.user.id) });
  });

  /** 改一个供应商；apiKey 留空表示不改。 */
  router.put("/llm/providers/:id", (request, response) => {
    const input = parseRequestBody(
      z
        .object({
          name: z.string().min(1).max(40).optional(),
          baseUrl: z.string().url().optional(),
          model: z.string().min(1).max(80).optional(),
          apiKey: z.string().max(200).optional(),
        })
        .strict(),
      request,
    );
    const updated = updateProvider(
      response.locals.auth.user.id,
      String(request.params.id),
      input,
    );
    if (updated === undefined) {
      throw new HttpError(404, "PROVIDER_NOT_FOUND", "找不到这个供应商。");
    }
    response.json(configView(response.locals.auth.user.id));
  });

  router.delete("/llm/providers/:id", (request, response) => {
    if (!deleteProvider(response.locals.auth.user.id, String(request.params.id))) {
      throw new HttpError(404, "PROVIDER_NOT_FOUND", "找不到这个供应商。");
    }
    response.json(configView(response.locals.auth.user.id));
  });

  /** 切换当前供应商 —— cc-switch 的核心动作。 */
  router.post("/llm/providers/:id/activate", (request, response) => {
    if (!activateProvider(response.locals.auth.user.id, String(request.params.id))) {
      throw new HttpError(404, "PROVIDER_NOT_FOUND", "找不到这个供应商。");
    }
    response.json(configView(response.locals.auth.user.id));
  });

  /** 拉取这个地址下 Key 可用的模型列表（各大平台都是 OpenAI 兼容的 /models）。 */
  router.post(
    "/llm/models",
    asyncRoute(async (request, response) => {
      const { baseUrl, apiKey } = parseRequestBody(
        z.object({ baseUrl: z.string().url(), apiKey: z.string().min(1).max(200) }).strict(),
        request,
      );
      if (apiKey.includes("://")) {
        throw new HttpError(400, "INVALID_KEY", "这看起来是接口地址，不是 API Key。");
      }
      try {
        const upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!upstream.ok) {
          throw new Error(`上游返回 ${upstream.status}`);
        }
        const payload = (await upstream.json()) as {
          data?: Array<{ id?: string; name?: string }>;
        };
        const models = (payload.data ?? [])
          .filter((item) => typeof item.id === "string" && item.id !== "")
          .map((item) => ({ id: item.id as string, name: item.name ?? (item.id as string) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        response.json({ models });
      } catch (error) {
        throw new HttpError(
          400,
          "MODELS_FAILED",
          `拉取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  /** 用已保存的 Key 拉这个供应商的模型列表（换模型时用）。 */
  router.post(
    "/llm/providers/:id/models",
    asyncRoute(async (request, response) => {
      const provider = readConfig(response.locals.auth.user.id).providers.find(
        (item) => item.id === String(request.params.id),
      );
      if (provider === undefined) {
        throw new HttpError(404, "PROVIDER_NOT_FOUND", "找不到这个供应商。");
      }
      try {
        const upstream = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!upstream.ok) throw new Error(`上游返回 ${upstream.status}`);
        const payload = (await upstream.json()) as {
          data?: Array<{ id?: string; name?: string }>;
        };
        const models = (payload.data ?? [])
          .filter((item) => typeof item.id === "string" && item.id !== "")
          .map((item) => ({ id: item.id as string, name: item.name ?? (item.id as string) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        response.json({ models });
      } catch (error) {
        throw new HttpError(
          400,
          "MODELS_FAILED",
          `拉取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  /** 用某个供应商发一次最小请求，验证 key 是否可用。 */
  router.post("/llm/providers/:id/test", asyncRoute(async (request, response) => {
    const provider = readConfig(response.locals.auth.user.id).providers.find(
      (item) => item.id === String(request.params.id),
    );
    if (provider === undefined) {
      throw new HttpError(404, "PROVIDER_NOT_FOUND", "找不到这个供应商。");
    }
    if (provider.apiKey === "") {
      throw new HttpError(400, "API_KEY_REQUIRED", "这个供应商还没有填 API Key。");
    }
    try {
      const started = Date.now();
      await chatJson({
        config: {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
          provider: provider.name.toLowerCase(),
        },
        system: "你是一个连通性测试助手，只输出 JSON。",
        user: '返回 {"ok": true}',
        schema: z.object({ ok: z.boolean() }),
        timeoutMs: 15_000,
      });
      response.json({ ok: true, latencyMs: Date.now() - started, model: provider.model });
    } catch (error) {
      throw new HttpError(
        400,
        "LLM_TEST_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }));

  /** 暂停 / 继续：只在会议处理跑到一半时有意义。 */
  router.post(
    "/control",
    (request, response: Response<unknown, AuthLocals>) => {
      const { projectId, action } = parseRequestBody(
        z.object({ projectId: z.string().min(1), action: z.enum(["pause", "resume"]) }).strict(),
        request,
      );
      assertMember(response.locals.auth, projectId);
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
      assertMember(response.locals.auth, projectId);
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
      assertMember(response.locals.auth, projectId);
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
    asyncRoute(async (request, response) => {
      const { projectId, mode } = parseRequestBody(ResetRequestSchema, request);
      try {
        availability.projectSummary(response.locals.auth, projectId);
      } catch {
        throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
      }

      if (mode === "seed" && process.env.NODE_ENV === "production") {
        throw new HttpError(
          409,
          "SEED_DISABLED",
          "生产环境不允许重建演示数据（会写入固定密码的演示账号）。",
        );
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
    }),
  );

  return router;
}
