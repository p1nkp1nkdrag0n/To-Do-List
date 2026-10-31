import { describe, expect, it, vi } from "vitest";

import {
  audioFormatFor,
  createTask,
  formatTranscript,
  transcribeAudio,
  type TranscriptSegment,
} from "../../../server/meeting/asr.js";

const CONFIG = { version: 1 as const, productId: "278578090", apiKey: "test-api-key" };

describe("思必驰录音文件转写客户端", () => {
  it("按扩展名识别音频格式", () => {
    expect(audioFormatFor("会议.MP3")).toBe("mp3");
    expect(audioFormatFor("meeting.m4a")).toBe("m4a");
    expect(audioFormatFor("voice.ogg")).toBe("ogg_opus");
    expect(audioFormatFor("note.txt")).toBeNull();
  });

  it("把逐句结果按说话人合并成段落", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 0, endMs: 1_000, text: "今天咱们碰一下。", speaker: 0 },
      { startMs: 1_000, endMs: 2_000, text: "营地我来订。", speaker: 0 },
      { startMs: 2_000, endMs: 3_000, text: "装备我负责。", speaker: 1 },
      { startMs: 3_000, endMs: 4_000, text: "行。", speaker: 0 },
    ];
    expect(formatTranscript(segments)).toBe(
      ["发言人1：今天咱们碰一下。营地我来订。", "发言人2：装备我负责。", "发言人1：行。"].join("\n"),
    );
  });

  it("没有 speaker 信息时不加前缀", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 0, endMs: 1_000, text: "第一句。", speaker: null },
      { startMs: 1_000, endMs: 2_000, text: "第二句。", speaker: null },
    ];
    expect(formatTranscript(segments)).toBe("第一句。第二句。");
  });

  it("走完 上传 → 建任务 → 轮询 → 取结果 全流程", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/lasr-file-api/v2/audio?")) {
        return new Response(JSON.stringify({ errno: 0, error: "", data: { audio_id: "audio-1" } }), { status: 200 });
      }
      if (url.includes("/slice/")) {
        return new Response(JSON.stringify({ errno: 0, data: { slices: 0 } }), { status: 200 });
      }
      if (url.includes("/lasr-file-api/v2/task?")) {
        return new Response(JSON.stringify({ errno: 0, data: { task_id: "task-1" } }), { status: 200 });
      }
      if (url.includes("/progress")) {
        const done = calls.filter((item) => item.includes("/progress")).length > 1;
        return new Response(JSON.stringify({ errno: 0, data: { progress: done ? 100 : 40 } }), { status: 200 });
      }
      if (url.includes("/result")) {
        return new Response(
          JSON.stringify({
            errno: 0,
            data: {
              result: [
                { bg: 0, ed: 1000, onebest: "甲说订营地。", speaker: 0 },
                { bg: 1000, ed: 2000, onebest: "乙说买装备。", speaker: 1 },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const progress: number[] = [];
    const transcript = await transcribeAudio({
      config: CONFIG,
      filename: "meeting.mp3",
      audio: new Uint8Array(9 * 1024 * 1024),
      fetchImpl,
      sleep: async () => {},
      onProgress: (value) => progress.push(value),
    });

    expect(transcript.text).toBe("发言人1：甲说订营地。\n发言人2：乙说买装备。");
    expect(progress.at(-1)).toBe(100);
    // 9MB → 3 片
    expect(calls.filter((item) => item.includes("/slice/"))).toHaveLength(3);
  });

  it("鉴权失败时给出可操作的提示", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errId: "120000", errMsg: "apikey auth verify error" }), { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeAudio({ config: CONFIG, filename: "a.mp3", audio: new Uint8Array(10), fetchImpl }),
    ).rejects.toThrow(/IP 白名单/);
  });

  it("创建任务时要求盲分说话人", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ errno: 0, data: { task_id: "t" } }), { status: 200 });
    }) as unknown as typeof fetch;
    await createTask(CONFIG, { audioId: "a", audioType: "mp3" }, fetchImpl);
    expect(body).toContain("speaker_number=-1");
  });
});

describe("转写纠错", () => {
  it("没有配置大模型时原样返回", async () => {
    const { correctTranscript } = await import("../../../server/meeting/asr-correct.js");
    const text = "秋叶恒负责演示脚本。";
    await expect(correctTranscript({ userId: "no-such-user", text, hotwords: ["邱业恒"] })).resolves.toBe(text);
  });

  it("没有热词时原样返回", async () => {
    const { correctTranscript } = await import("../../../server/meeting/asr-correct.js");
    const text = "秋叶恒负责演示脚本。";
    await expect(correctTranscript({ userId: "no-such-user", text, hotwords: [] })).resolves.toBe(text);
  });
});
