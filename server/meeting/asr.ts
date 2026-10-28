/**
 * 思必驰「录音文件长语音转写」客户端。
 *
 * 流程（文档 /docs/lasr_native_2）：
 *   1. POST /lasr-file-api/v2/audio            创建 audio_id（要告诉它分几片）
 *   2. POST /lasr-file-api/v2/audio/{id}/slice/{i}  逐片上传（每片 ≤4MB）
 *   3. POST /lasr-file-api/v2/task             创建转写任务（speaker_number=-1 盲分）
 *   4. GET  /lasr-file-api/v2/task/{id}/progress   轮询进度
 *   5. GET  /lasr-file-api/v2/task/{id}/result     取结果（按句返回，带 speaker）
 *
 * 注意：apiKey 绑定了调用方的公网 IP（服务授权 + IP 白名单），
 * 换网络后需要到控制台把新 IP 加进去。
 */
import type { AsrConfig } from "./asr-config.js";

const BASE = "https://lasr.duiopen.com";
const SLICE_BYTES = 4 * 1024 * 1024;

export type AudioFormat = "mp3" | "wav" | "m4a" | "aac" | "ogg_opus" | "ogg_speex" | "pcm" | "opus";

const EXTENSION_TO_FORMAT: Record<string, AudioFormat> = {
  mp3: "mp3",
  wav: "wav",
  m4a: "m4a",
  aac: "aac",
  ogg: "ogg_opus",
  opus: "opus",
  pcm: "pcm",
};

export function audioFormatFor(filename: string): AudioFormat | null {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_TO_FORMAT[extension] ?? null;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker: number | null;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  durationMs: number;
}

export class AsrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AsrError";
  }
}

function withQuery(path: string, config: AsrConfig): string {
  const params = new URLSearchParams({
    productId: config.productId,
    apiKey: config.apiKey,
  });
  return `${BASE}${path}?${params.toString()}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      throw new AsrError(`思必驰返回 HTTP ${response.status}：${text.slice(0, 160)}`, response.status);
    }
    throw new AsrError(`思必驰返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 160)}`, response.status);
  }

  // 思必驰的错误有两种格式：errId/errMsg（鉴权、额度、流控）和 errno/error（业务错误）。
  const errId = payload.errId === undefined ? "" : String(payload.errId);
  if (errId !== "") {
    if (errId === "120100") {
      throw new AsrError(
        "思必驰额度不足：这个产品还没有可用的套餐。到控制台「服务开通与购买 → 购买套餐」领取免费套餐（24 小时）或购买后再试。",
        response.status,
      );
    }
    if (errId === "120200") {
      throw new AsrError("思必驰触发流控（同时转写任务太多），等几分钟再试。", response.status);
    }
    throw new AsrError(
      `思必驰鉴权失败（${errId} ${String(payload.errMsg ?? "")}）：检查 productId / apiKey，以及当前公网 IP 是否在控制台的 IP 白名单里。`,
      response.status,
    );
  }

  const errno = Number(payload.errno ?? 0);
  if (errno !== 0) {
    throw new AsrError(`思必驰返回错误 ${errno}：${String(payload.error ?? "未知错误")}`, response.status);
  }
  if (!response.ok) {
    throw new AsrError(`思必驰返回 HTTP ${response.status}：${text.slice(0, 160)}`, response.status);
  }
  return payload;
}

/** 1. 创建音频，告诉服务端会分几片。 */
export async function createAudio(
  config: AsrConfig,
  input: { audioType: AudioFormat; sliceCount: number },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    audio_type: input.audioType,
    sample_rate: "16000",
    channel: "1",
    sample_bytes: "2",
    slice_num: String(input.sliceCount),
  });
  const response = await fetchImpl(withQuery("/lasr-file-api/v2/audio", config), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  const payload = await readJson(response);
  const data = payload.data as { audio_id?: string } | undefined;
  if (data?.audio_id === undefined) throw new AsrError("思必驰没有返回 audio_id");
  return data.audio_id;
}

/** 2. 上传一片。 */
export async function uploadSlice(
  config: AsrConfig,
  audioId: string,
  index: number,
  chunk: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([chunk]), "slice.bin");
  const response = await fetchImpl(
    withQuery(`/lasr-file-api/v2/audio/${encodeURIComponent(audioId)}/slice/${index}`, config),
    { method: "POST", body: form },
  );
  await readJson(response);
}

/** 3. 创建转写任务：盲分说话人 + 中文 + 口语顺滑。 */
export async function createTask(
  config: AsrConfig,
  input: { audioId: string; audioType: AudioFormat; hotwords?: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    audio_id: input.audioId,
    audio_type: input.audioType,
    lang: "cn",
    use_txt_smooth: "1",
    use_inverse_txt: "1",
    // -1 = 盲分：不预设人数，让模型自己聚类。会议人数不固定，这样最稳。
    speaker_number: "-1",
  });
  // 项目成员的名字作为热词，避免「邱业恒」被听成「邱叶恒」这类同音错误。
  const hotwords = (input.hotwords ?? []).map((word) => word.trim()).filter((word) => word.length >= 2 && word.length <= 10);
  if (hotwords.length > 0) {
    body.set(
      "phrase_list",
      JSON.stringify([{ name: "name", words: [...new Set(hotwords)].slice(0, 200), boost: 1 }]),
    );
  }
  const response = await fetchImpl(withQuery("/lasr-file-api/v2/task", config), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  const payload = await readJson(response);
  const data = payload.data as { task_id?: string } | undefined;
  if (data?.task_id === undefined) throw new AsrError("思必驰没有返回 task_id");
  return data.task_id;
}

/** 4. 查进度（0–100）。 */
export async function taskProgress(
  config: AsrConfig,
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const response = await fetchImpl(
    withQuery(`/lasr-file-api/v2/task/${encodeURIComponent(taskId)}/progress`, config),
    { method: "GET" },
  );
  const payload = await readJson(response);
  const data = payload.data as { progress?: number } | undefined;
  return Number(data?.progress ?? 0);
}

interface RawSegment {
  bg?: number;
  ed?: number;
  onebest?: string;
  speaker?: number;
}

/** 5. 取结果并拼成「发言人N：……」的纪要文本。 */
export async function taskResult(
  config: AsrConfig,
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Transcript> {
  const response = await fetchImpl(
    withQuery(`/lasr-file-api/v2/task/${encodeURIComponent(taskId)}/result`, config),
    { method: "GET" },
  );
  const payload = await readJson(response);
  const data = payload.data as { result?: RawSegment[] } | undefined;
  const segments = (data?.result ?? []).map((item) => ({
    startMs: Number(item.bg ?? 0),
    endMs: Number(item.ed ?? 0),
    text: String(item.onebest ?? "").trim(),
    speaker: item.speaker === undefined ? null : Number(item.speaker),
  }));
  return { text: formatTranscript(segments), segments, durationMs: segments.at(-1)?.endMs ?? 0 };
}

/** 把逐句结果合并成段落：同一个人连续说的句子合并成一段。 */
export function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  let currentSpeaker: number | null | undefined;
  let currentText: string[] = [];

  const flush = () => {
    if (currentText.length === 0) return;
    const prefix = currentSpeaker === null || currentSpeaker === undefined ? "" : `发言人${currentSpeaker + 1}：`;
    lines.push(`${prefix}${currentText.join("")}`);
    currentText = [];
  };

  for (const segment of segments) {
    if (segment.text === "") continue;
    if (segment.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = segment.speaker;
    }
    currentText.push(segment.text);
  }
  flush();
  return lines.join("\n");
}

export interface TranscribeOptions {
  config: AsrConfig;
  filename: string;
  audio: Uint8Array;
  /** 项目成员名等热词，提升人名识别率。 */
  hotwords?: string[];
  onProgress?: (progress: number, note: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 最长等待毫秒数，默认 20 分钟（1 小时音频通常几分钟出结果）。 */
  timeoutMs?: number;
}

/** 完整流程：上传 → 建任务 → 轮询 → 取结果。 */
export async function transcribeAudio(options: TranscribeOptions): Promise<Transcript> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = options.onProgress ?? (() => {});

  const audioType = audioFormatFor(options.filename);
  if (audioType === null) {
    throw new AsrError("不支持的音频格式：请用 mp3 / wav / m4a / aac / ogg 文件。");
  }
  if (options.audio.byteLength === 0) throw new AsrError("音频文件是空的。");

  const sliceCount = Math.max(1, Math.ceil(options.audio.byteLength / SLICE_BYTES));
  report(2, `上传音频（共 ${sliceCount} 片）`);
  const audioId = await createAudio(options.config, { audioType, sliceCount }, fetchImpl);

  for (let index = 0; index < sliceCount; index += 1) {
    const chunk = options.audio.subarray(index * SLICE_BYTES, (index + 1) * SLICE_BYTES);
    await uploadSlice(options.config, audioId, index, chunk, fetchImpl);
    report(2 + Math.round(((index + 1) / sliceCount) * 30), `上传第 ${index + 1}/${sliceCount} 片`);
  }

  report(35, "已上传，等待服务端排队");
  const taskId = await createTask(
    options.config,
    { audioId, audioType, hotwords: options.hotwords },
    fetchImpl,
  );

  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60 * 1000);
  let progress = 0;
  while (Date.now() < deadline) {
    progress = await taskProgress(options.config, taskId, fetchImpl);
    report(35 + Math.round(progress * 0.6), `服务端进度 ${progress}%`);
    if (progress >= 100) break;
    await sleep(3_000);
  }
  if (progress < 100) throw new AsrError("转写超时，请稍后在思必驰控制台查看任务结果。");

  report(98, "服务端完成，正在取回结果");
  const transcript = await taskResult(options.config, taskId, fetchImpl);
  if (transcript.segments.length === 0) throw new AsrError("转写结果为空，可能是音频里没有可识别的人声。");
  report(100, "转写完成");
  return transcript;
}
