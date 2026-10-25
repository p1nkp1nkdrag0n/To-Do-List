/**
 * 供应商预设：选一个模板就带出接口地址和可选模型，用户只填 Key。
 * 注意：这里的 baseUrl 都是 OpenAI 兼容根地址（不带 /chat/completions）。
 */
export interface LlmPreset {
  key: string;
  label: string;
  /** 创建时的默认名称 */
  name: string;
  baseUrl: string;
  models: string[];
  /** 是否允许手填地址和模型（只有「自定义」是 true） */
  freeform?: boolean;
  note?: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek 官方",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
    ],
  },
  {
    key: "dashscope",
    label: "通义千问",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
  },
  {
    key: "moonshot",
    label: "Kimi（月之暗面）",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.6", "kimi-k3", "kimi-k3.1-pro", "kimi-k2.7-code"],
    note: "Kimi 旧版 moonshot-v1-* 已下线；用「用 Key 拉取可用模型」可以看到你账号实际能用的名字。",
  },
  {
    key: "ollama",
    label: "本地 Ollama",
    name: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b"],
    note: "本地服务不需要 Key，但 Ollama 要求环境变量 OLLAMA_ORIGINS 允许跨域。",
  },
  {
    key: "custom",
    label: "自定义（OpenAI 兼容）",
    name: "自定义供应商",
    baseUrl: "",
    models: [],
    freeform: true,
  },
];

export function presetByKey(key: string): LlmPreset | undefined {
  return LLM_PRESETS.find((item) => item.key === key);
}

/** 从已保存的地址反查模板，用来决定编辑时能不能用下拉选择模型。 */
export function presetByBaseUrl(baseUrl: string): LlmPreset | undefined {
  const normalized = baseUrl.replace(/\/$/, "");
  return LLM_PRESETS.find(
    (item) => !item.freeform && item.baseUrl.replace(/\/$/, "") === normalized,
  );
}
