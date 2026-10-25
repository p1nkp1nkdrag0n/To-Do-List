/**
 * 模型选择（照 Harness 账号设置里「模型」那一页的样子）：
 * 一列可选模型，点一下就是当前使用；没有 key 的才需要填一次。
 * 新增入口在底部，点开才出预设，平时不占地方。
 */
import { useCallback, useEffect, useState } from "react";

import { Check, Plus, RefreshCw, X } from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import { LLM_PRESETS, presetByBaseUrl, type LlmPreset } from "./llm-presets";

interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  active: boolean;
  source: "file" | "env";
}

interface LlmConfigView {
  activeId: string | null;
  providers: ProviderView[];
  envAvailable: boolean;
}

export function LlmSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<LlmConfigView>();
  const [pendingKey, setPendingKey] = useState("");
  const [needKeyFor, setNeedKeyFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  /** 每个供应商可选的模型（预设 + 从平台拉到的）。 */
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    try {
      const next = await api.get<LlmConfigView>("/api/meeting/llm-config");
      setView(next);
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setAdding(false);
      setNeedKeyFor(null);
      setPendingKey("");
      setMessage("");
      void load();
    }
  }, [open, load]);

  const optionsFor = (provider: ProviderView): string[] => {
    const preset = presetByBaseUrl(provider.baseUrl);
    const base = preset?.models ?? [];
    const merged = [...new Set([provider.model, ...(modelOptions[provider.id] ?? []), ...base])];
    return merged;
  };

  const changeModel = async (provider: ProviderView, model: string) => {
    if (model === provider.model) return;
    setBusy("切换模型…");
    setMessage("");
    try {
      await api.put(`/api/meeting/llm/providers/${provider.id}`, { model });
      await load();
      setMessage(`已切到 ${model}`);
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const syncModels = async (provider: ProviderView) => {
    setBusy("拉取模型…");
    setMessage("");
    try {
      const result = await api.post<{ models: string[] }>(
        `/api/meeting/llm/providers/${provider.id}/models`,
      );
      setModelOptions((current) => ({ ...current, [provider.id]: result.models }));
      setMessage(`拉到 ${result.models.length} 个可用模型`);
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const activate = async (id: string) => {
    setBusy("切换中…");
    setMessage("");
    try {
      const next = await api.post<LlmConfigView>(`/api/meeting/llm/providers/${id}/activate`);
      setView(next);
      setNeedKeyFor(null);
      setMessage("已切换");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const saveKeyAndUse = async (provider: ProviderView) => {
    if (pendingKey.trim() === "") {
      setMessage("请先粘贴 API Key");
      return;
    }
    if (pendingKey.includes("://")) {
      setMessage("这看起来是接口地址，不是 API Key。Key 一般以 sk- 开头。");
      return;
    }
    setBusy("保存中…");
    try {
      await api.put(`/api/meeting/llm/providers/${provider.id}`, { apiKey: pendingKey.trim() });
      await api.post(`/api/meeting/llm/providers/${provider.id}/activate`);
      setPendingKey("");
      setNeedKeyFor(null);
      await load();
      setMessage("已保存并切换");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const addProvider = async (preset: LlmPreset, apiKey: string, model: string) => {
    if (apiKey.includes("://")) {
      setMessage("这看起来是接口地址，不是 API Key。Key 一般以 sk- 开头。");
      return;
    }
    setBusy("添加中…");
    try {
      await api.post("/api/meeting/llm/providers", {
        name: preset.name,
        baseUrl: preset.baseUrl,
        model,
        apiKey,
      });
      setAdding(false);
      setPendingKey("");
      await load();
      setMessage("已添加");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  if (!open) return null;

  return (
    <div className="llm-mask" role="dialog" aria-modal="true">
      <div className="llm-panel llm-panel-narrow">
        <header className="llm-head">
          <div>
            <strong>模型</strong>
            <span>选择一个用来处理会议纪要的大模型</span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="llm-scroll">
          {adding ? (
            <AddProvider
              busy={busy !== ""}
              onCancel={() => setAdding(false)}
              onAdd={(preset, key, model) => void addProvider(preset, key, model)}
            />
          ) : (
            <>
              {view === undefined ? <p className="llm-empty">读取中…</p> : null}
              {view?.providers.length === 0 ? (
                <p className="llm-empty">还没有模型，点下面「添加模型」开始。</p>
              ) : null}
              {view?.providers.map((provider) => (
                <div key={provider.id} className={`llm-row ${provider.active ? "on" : ""}`}>
                  <button
                    type="button"
                    className="llm-row-main"
                    onClick={() => {
                      if (!provider.hasKey) {
                        setNeedKeyFor(provider.id === needKeyFor ? null : provider.id);
                        return;
                      }
                      if (!provider.active) void activate(provider.id);
                    }}
                  >
                    <span className="llm-row-title">
                      {provider.name}
                      <em>{provider.model}</em>
                    </span>
                    <span className="llm-row-meta">
                      {provider.hasKey ? provider.keyHint : "未填 Key"}
                    </span>
                    {provider.active ? <Check className="llm-row-check" size={16} /> : null}
                  </button>

                  <div className="llm-row-tools">
                    <select
                      value={provider.model}
                      disabled={busy !== ""}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => void changeModel(provider, event.target.value)}
                    >
                      {optionsFor(provider).map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-button"
                      type="button"
                      title="用 Key 拉取这个平台可用的模型"
                      disabled={busy !== "" || !provider.hasKey}
                      onClick={() => void syncModels(provider)}
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>

                  {needKeyFor === provider.id ? (
                    <div className="llm-row-key">
                      <input
                        type="password"
                        autoFocus
                        placeholder="API Key（sk- 开头），回车保存"
                        value={pendingKey}
                        onChange={(event) => setPendingKey(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveKeyAndUse(provider);
                        }}
                      />
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy !== ""}
                        onClick={() => void saveKeyAndUse(provider)}
                      >
                        保存
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}

              <button className="llm-add-row" type="button" onClick={() => setAdding(true)}>
                <Plus size={15} /> 添加模型
              </button>

              {view?.envAvailable === true ? (
                <p className="llm-note">
                  环境变量里也配了 Key；这里选中的模型优先，环境变量只做兜底。
                </p>
              ) : null}
            </>
          )}
        </div>

        <footer className="llm-foot llm-foot-plain">
          <span className="llm-status">{message}</span>
          <button className="secondary-button" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}

function AddProvider({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (preset: LlmPreset, apiKey: string, model: string) => void;
}) {
  const [presetKey, setPresetKey] = useState<string>("deepseek");
  const [model, setModel] = useState<string>("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");

  const fetchModels = async () => {
    setFetching(true);
    setFetchError("");
    try {
      const result = await api.post<{ models: string[] }>("/api/meeting/llm/models", {
        baseUrl: preset.baseUrl,
        apiKey,
      });
      setModelOptions(result.models);
      if (result.models.length > 0) setModel(result.models[0]!);
    } catch (caught) {
      setFetchError(errorMessage(caught));
    } finally {
      setFetching(false);
    }
  };

  const preset = LLM_PRESETS.find((item) => item.key === presetKey) ?? LLM_PRESETS[0]!;
  const freeform = preset.freeform === true;

  return (
    <div className="llm-add-form">
      <p className="llm-add-title">添加模型</p>
      <div className="llm-chips">
        {LLM_PRESETS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`llm-chip ${item.key === presetKey ? "on" : ""}`}
            onClick={() => {
              setPresetKey(item.key);
              setModel(item.models[0] ?? "");
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="llm-field">
        接口地址
        <input value={preset.baseUrl} readOnly className="locked" placeholder="https://..." />
      </label>

      <label className="llm-field">
        模型
        {modelOptions.length > 0 ? (
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            {modelOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            placeholder="模型名"
            onChange={(event) => setModel(event.target.value)}
          />
        )}
        <button
          className="link-button llm-fetch"
          type="button"
          onClick={() => void fetchModels()}
        >
          {fetching ? "拉取中…" : "用 Key 拉取可用模型"}
        </button>
      </label>

      <label className="llm-field">
        API Key
        <input
          type="password"
          value={apiKey}
          placeholder="Key 一般以 sk- 开头"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      {fetchError !== "" ? <p className="llm-note llm-note-error">{fetchError}</p> : null}
      {preset.note !== undefined ? <p className="llm-note">{preset.note}</p> : null}

      <div className="llm-add-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={busy || model.trim() === ""}
          onClick={() => onAdd(preset, apiKey.trim(), model.trim())}
        >
          添加
        </button>
      </div>
    </div>
  );
}

/** 供外部判断某地址对应哪个预设（目前没用到，保留给以后编辑）。 */
export function presetOf(baseUrl: string): LlmPreset | undefined {
  return presetByBaseUrl(baseUrl);
}
