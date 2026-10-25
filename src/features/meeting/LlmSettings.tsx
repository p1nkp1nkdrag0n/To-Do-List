/**
 * AI 供应商切换面板（照 cc-switch 的样子做的）：
 * 左边一列供应商，右边编辑当前选中的那个，点一下就切换。
 */
import { useCallback, useEffect, useState } from "react";

import { Check, Plus, Trash2, Zap } from "lucide-react";

import { api, errorMessage } from "../../lib/api";

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

interface Preset {
  key: string;
  label: string;
  name: string;
  baseUrl: string;
  model: string;
}

const PRESETS: Preset[] = [
  { key: "deepseek", label: "DeepSeek 官方", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { key: "siliconflow", label: "硅基流动", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  { key: "dashscope", label: "通义千问", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { key: "zhipu", label: "智谱 GLM", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { key: "moonshot", label: "Kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "ollama", label: "本地 Ollama", name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  { key: "custom", label: "自定义", name: "自定义供应商", baseUrl: "", model: "" },
];

const EMPTY_FORM = { name: "", baseUrl: "", model: "", apiKey: "" };

export function LlmSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<LlmConfigView>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (keepSelection?: string) => {
    try {
      const next = await api.get<LlmConfigView>("/api/meeting/llm-config");
      setView(next);
      const target =
        keepSelection ??
        selectedId ??
        next.activeId ??
        next.providers[0]?.id ??
        null;
      setSelectedId(target);
      const provider = next.providers.find((item) => item.id === target);
      if (provider !== undefined) {
        setForm({
          name: provider.name,
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: "",
        });
      }
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }, [selectedId]);

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = view?.providers.find((item) => item.id === selectedId);

  const pick = (provider: ProviderView) => {
    setCreating(false);
    setSelectedId(provider.id);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
    });
    setMessage("");
  };

  const startCreate = (presetKey: string) => {
    const preset = PRESETS.find((item) => item.key === presetKey) ?? PRESETS[0]!;
    setCreating(true);
    setSelectedId(null);
    setForm({ name: preset.name, baseUrl: preset.baseUrl, model: preset.model, apiKey: "" });
    setMessage("");
  };

  const save = async () => {
    setBusy("保存中…");
    setMessage("");
    try {
      if (creating) {
        await api.post("/api/meeting/llm/providers", form);
      } else if (selectedId !== null) {
        await api.put(`/api/meeting/llm/providers/${selectedId}`, form);
      }
      await load(selectedId ?? undefined);
      setCreating(false);
      setMessage("已保存");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const activate = async (id: string) => {
    setBusy("切换中…");
    try {
      await api.post(`/api/meeting/llm/providers/${id}/activate`);
      await load(id);
      setMessage("已切换");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const test = async (id: string) => {
    setBusy("测试中…");
    setMessage("");
    try {
      const result = await api.post<{ latencyMs: number; model: string }>(
        `/api/meeting/llm/providers/${id}/test`,
      );
      setMessage(`连接正常：${result.model}，${result.latencyMs}ms`);
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const remove = async (id: string) => {
    setBusy("删除中…");
    try {
      await api.delete(`/api/meeting/llm/providers/${id}`, {});
      setSelectedId(null);
      await load();
      setMessage("已删除");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  if (!open) return null;

  return (
    <div className="llm-mask" role="dialog" aria-modal="true">
      <div className="llm-panel">
        <header className="llm-head">
          <div>
            <strong>AI 供应商</strong>
            <span>选一个当前要用的，点一下就能切</span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="llm-body">
          <aside className="llm-list">
            {view?.providers.length === 0 ? (
              <p className="llm-empty">还没有供应商，右边先加一个。</p>
            ) : null}
            {view?.providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={`llm-item ${provider.id === selectedId && !creating ? "on" : ""}`}
                onClick={() => pick(provider)}
              >
                <span className="llm-item-name">
                  {provider.active ? <Check size={13} /> : null}
                  {provider.name}
                </span>
                <span className="llm-item-host">{hostOf(provider.baseUrl)}</span>
              </button>
            ))}

            <div className="llm-list-foot">
              <label className="llm-add">
                <Plus size={13} /> 添加供应商
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value !== "") startCreate(event.target.value);
                    event.target.value = "";
                  }}
                >
                  <option value="">选择模板…</option>
                  {PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </aside>

          <section className="llm-form">
            {view?.envAvailable ? (
              <p className="llm-note">
                检测到环境变量里也配了 key；页面里选中的供应商优先，其次才用它。
              </p>
            ) : null}

            <div className="llm-grid">
              <label>
                名称
                <input
                  value={form.name}
                  placeholder="例如 DeepSeek"
                  onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                />
              </label>
              <label>
                接口地址
                <input
                  value={form.baseUrl}
                  placeholder="https://api.deepseek.com"
                  onChange={(event) => setForm((c) => ({ ...c, baseUrl: event.target.value }))}
                />
              </label>
              <label>
                模型
                <input
                  value={form.model}
                  placeholder="deepseek-chat"
                  onChange={(event) => setForm((c) => ({ ...c, model: event.target.value }))}
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  value={form.apiKey}
                  placeholder={
                    selected?.hasKey === true ? `已保存 ${selected.keyHint}（留空不改）` : "sk-..."
                  }
                  onChange={(event) => setForm((c) => ({ ...c, apiKey: event.target.value }))}
                />
              </label>
            </div>

            <footer className="llm-foot">
              <span className="llm-status">{message}</span>
              {selected !== undefined && !creating ? (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void test(selected.id)}
                  >
                    测试
                  </button>
                  {!selected.active ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy !== ""}
                      onClick={() => void activate(selected.id)}
                    >
                      <Zap size={13} /> 设为当前
                    </button>
                  ) : (
                    <span className="llm-active-tag">当前使用中</span>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    title="删除"
                    disabled={busy !== ""}
                    onClick={() => void remove(selected.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              ) : null}
              <button
                className="primary-button"
                type="button"
                disabled={busy !== "" || form.name.trim() === "" || form.baseUrl.trim() === ""}
                onClick={() => void save()}
              >
                {creating ? "添加" : "保存"}
              </button>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
