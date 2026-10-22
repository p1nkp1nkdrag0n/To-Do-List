/**
 * 60 秒会议录音的「预置转写稿」。
 *
 * ASR 还没接（等思必驰凭证），演示时用它回放，接口形状和真转写一致：
 * 一句话 = 说话人 + 时间戳 + 文本。换成真 ASR 时只替换数据来源。
 */

export interface TranscriptLine {
  speaker: string;
  atMs: number;
  text: string;
}

export interface ExtractedTaskCard {
  key: string;
  title: string;
  owner: string;
  hours: number;
  startHint: string;
  dependency?: string;
}

export const DEMO_TRANSCRIPT: TranscriptLine[] = [
  { speaker: "邱业恒", atMs: 0, text: "今天主要三件事：接口、甘特图、还有最后的彩排，一个一个来。" },
  { speaker: "张工", atMs: 4_200, text: "MCP 工具层接口联调我接，大概要十个钟头，这周我周三下午请假。" },
  { speaker: "邱业恒", atMs: 9_000, text: "那接口这块就交给你，张工。截止先定在这一周结束，行吗？" },
  { speaker: "张工", atMs: 13_500, text: "行，我尽量，周三之后我只有晚上有空。" },
  { speaker: "李工", atMs: 17_800, text: "甘特图和冲突面板我来调，等接口好了我就能开始。" },
  { speaker: "邱业恒", atMs: 22_400, text: "注意别太早开始，接口没好你调不了。" },
  { speaker: "李工", atMs: 26_000, text: "那我先不动，等张工那边完我再上。" },
  { speaker: "邱业恒", atMs: 30_500, text: "会议录音的脚本和演示话术我来写，两三天够。" },
  { speaker: "李工", atMs: 35_200, text: "最后彩排和录屏也得留时间，别都堆在最后一天。" },
  { speaker: "邱业恒", atMs: 39_800, text: "彩排和兜底录屏我来，等甘特图那边完我就开始。" },
  { speaker: "张工", atMs: 44_500, text: "那我先把接口文档过一遍，有不确定的我随时问。" },
  { speaker: "邱业恒", atMs: 49_000, text: "好，那就这样：张工接口，李工图表，我脚本和彩排。" },
  { speaker: "李工", atMs: 54_000, text: "收到，有事群里说。" },
  { speaker: "邱业恒", atMs: 58_000, text: "散会。" },
];

export const DEMO_TASKS: ExtractedTaskCard[] = [
  { key: "T2", title: "MCP 工具层接口联调", owner: "张工", hours: 10, startHint: "下周一开始" },
  { key: "T3", title: "甘特图与冲突面板联调", owner: "李工", hours: 8, startHint: "下周", dependency: "依赖接口联调" },
  { key: "T1", title: "会议录音脚本与演示话术定稿", owner: "邱业恒", hours: 4, startHint: "今天开始" },
  { key: "T4", title: "全流程彩排与兜底录屏", owner: "邱业恒", hours: 4, startHint: "最后两天", dependency: "依赖图表联调" },
];

export const DEMO_AUDIO_SECONDS = 60;
