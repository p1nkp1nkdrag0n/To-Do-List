/**
 * AI 供应商切换面板（cc-switch 风格）：
 * 左边一列供应商，右边编辑；选模板自动带出地址与模型，只让用户填 Key。
 */
import { useCallback, useEffect, useState } from "react";

import { Check, Lock, Plus, Trash2, Zap } from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import { LLM_PRESETS, presetByBaseUrl, presetByKey, type LlmPreset } from "./llm-presets";

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

const EMPTY_FORM = { name: "", baseUrl: "", model: "", apiKey: "" };

export function LlmSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<LlmConfigView>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  /** 当前正在套用的模板；自定义时为 undefined。 */
  const [preset, setPreset] = useState<LlmPreset | undefined>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const applyProvider = useCallback((provider: ProviderView) => {
    setSelectedId(provider.id);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
    });
    setPreset(presetByBaseUrl(provider.baseUrl));
    setMessage("");
  }, []);

  const load = useCallback(
    async (keepSelection?: string) => {
      try {
        const next = await api.get<LlmConfigView>("/api/meeting/llm-config");
        setView(next);
        const target = keepSelection ?? selectedId ?? next.activeId ?? next.providers[0]?.id ?? null;
        setSelectedId(target);
        const provider = next.providers.find((item) => item.id === target);
        if (provider !== undefined) applyProvider(provider);
      } catch (caught) {
        setMessage(errorMessage(caught));
      }
    },
    [applyProvider, selectedId],
  );

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = view?.providers.find((item) => item.id === selectedId);

  const startCreate = (presetKey: string) => {
    const next = presetByKey(presetKey);
    if (next === undefined) return;
    setCreating(true);
    setSelectedId(null);
    setPreset(next.freeform === true ? undefined : next);
    setForm({
      name: next.name,
      baseUrl: next.baseUrl,
      model: next.models[0] ?? "",
      apiKey: "",
    });
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
      const next = await api.get<LlmConfigView>("/api/meeting/llm-config");
      setView(next);
      setCreating(false);
      const target = next.activeId ?? next.providers[0]?.id ?? null;
      const provider = next.providers.find((item) => item.id === target);
      if (provider !== undefined) applyProvider(provider);
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
      const next = await api.post<LlmConfigView>(`/api/meeting/llm/providers/${id}/activate`);
      setView(next);
      const provider = next.providers.find((item) => item.id === id);
      if (provider !== undefined) applyProvider(provider);
      setMessage("已切换，之后都用它");
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

  const locked = preset !== undefined && preset.freeform !== true;
  const models = preset?.models ?? [];
  const canSave = form.name.trim() !== "" && form.baseUrl.trim() !== "" && form.model.trim() !== "";

  return (
    <div className="llm-mask" role="dialog" aria-modal="true">
      <div className="llm-panel">
        <header className="llm-head">
          <div>
            <strong>AI 供应商</strong>
            <span>选一个模板，填 Key 就能用；点一下切换当前使用</span>
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
                onClick={() => {
                  setCreating(false);
                  applyProvider(provider);
                }}
              >
                <span className="llm-item-name">
                  {provider.active ? <Check size={13} /> : null}
                  {provider.name}
                </span>
                <span className="llm-item-host">
                  {provider.model} · {hostOf(provider.baseUrl)}
                </span>
              </button>
            ))}

            <div className="llm-list-foot">
              <div className="llm-add-title">
                <Plus size={13} /> 添加供应商
              </div>
              <div className="llm-add-grid">
                {LLM_PRESETS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="llm-preset"
                    onClick={() => startCreate(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="llm-form">
            {creating ? null : (
              <p className="llm-current">
                正在编辑：<strong>{selected?.name ?? "—"}</strong>
                {selected?.active === true ? <span className="llm-active-tag">当前使用中</span> : null}
              </p>
            )}
            {preset?.note !== undefined ? <p className="llm-note">{preset.note}</p> : null}
            {view?.envAvailable ? (
              <p className="llm-note">
                环境变量里也配了 key；页面里选中的供应商优先，环境变量只做兜底。
              </p>
            ) : null}

            <div className="llm-grid">
              <label>
                名称
                <input
                  value={form.name}
                  placeholder="例如 DeepSeek"
                  readOnly={locked}
                  className={locked ? "locked" : ""}
                  onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                />
              </label>
              <label>
                接口地址
                {locked ? (
                  <span className="llm-locked-line">
                    <Lock size={12} /> {form.baseUrl}
                  </span>
                ) : (
                  <input
                    value={form.baseUrl}
                    placeholder="https://api.deepseek.com"
                    onChange={(event) => setForm((c) => ({ ...c, baseUrl: event.target.value }))}
                  />
                )}
              </label>
              <label>
                模型
                {locked && models.length > 0 ? (
                  <select
                    value={form.model}
                    onChange={(event) => setForm((c) => ({ ...c, model: event.target.value }))}
                  >
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                    {models.includes(form.model) ? null : (
                      <option value={form.model}>{form.model}</option>
                    )}
                  </select>
                ) : (
                  <input
                    value={form.model}
                    placeholder="deepseek-chat"
                    onChange={(event) => setForm((c) => ({ ...c, model: event.target.value }))}
                  />
                )}
              </label>
              <label>
                API Key
                <input
                  type="password"
                  value={form.apiKey}
                  placeholder={
                    selected?.hasKey === true ? `已保存 ${selected.keyHint}（留空不改）` : "粘贴你的 Key"
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
                  ) : null}
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
                disabled={busy !== "" || !canSave}
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
