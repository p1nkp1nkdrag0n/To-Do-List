/**
 * 模型选择（照 Harness 账号设置里「模型」那一页的样子）：
 * 一列可选模型，点一下就是当前使用；没有 key 的才需要填一次。
 * 新增入口在底部，点开才出预设，平时不占地方。
 */
import { useCallback, useEffect, useState, useRef } from "react";

import { Check, Plus, X } from "lucide-react";

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
  const [asr, setAsr] = useState<{ productId: string; keyHint: string; hasKey: boolean }>();
  const [asrProductId, setAsrProductId] = useState("");
  const [asrKey, setAsrKey] = useState("");
  const [asrMessage, setAsrMessage] = useState("");
  const [asrTab, setAsrTab] = useState<"import" | "manual">("import");
  const [importText, setImportText] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [shareText, setShareText] = useState("");
  const [modelOptions, setModelOptions] = useState<
    Record<string, Array<{ id: string; name: string }>>
  >({});

  const syncAll = useCallback(async (providers: ProviderView[]) => {
    const withKey = providers.filter((item) => item.hasKey);
    await Promise.all(
      withKey.map(async (provider) => {
        try {
          const result = await api.post<{ models: Array<{ id: string; name: string }> }>(
            `/api/meeting/llm/providers/${provider.id}/models`,
          );
          if (result.models.length > 0) {
            setModelOptions((current) => ({ ...current, [provider.id]: result.models }));
          }
        } catch {
          // 平台没开 /models 或没网时静默忽略，继续用内置列表。
        }
      }),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.get<LlmConfigView>("/api/meeting/llm-config");
      setView(next);
      // 自动跟上平台的新模型：每次打开面板都问一次 /models。
      void syncAll(next.providers);
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }, [syncAll]);

  useEffect(() => {
    if (open) {
      setAdding(false);
      setNeedKeyFor(null);
      setPendingKey("");
      setMessage("");
      void load();
      setAsrMessage("");
      setAsrKey("");
      void api
        .get<{ productId: string; keyHint: string; hasKey: boolean }>("/api/meeting/asr-config")
        .then((config) => {
          setAsr(config);
          setAsrProductId(config.productId);
        })
        .catch(() => setAsr(undefined));
    }
  }, [open, load]);

  /** 下拉选项：当前模型 + 平台返回的（带友好名）+ 内置预设。 */
  const optionsFor = (provider: ProviderView): Array<{ id: string; label: string }> => {
    const preset = presetByBaseUrl(provider.baseUrl);
    const fromApi = modelOptions[provider.id] ?? [];
    const labelOf = (id: string): string => {
      const hit = fromApi.find((item) => item.id === id);
      return hit !== undefined && hit.name !== hit.id ? `${hit.name} · ${id}` : id;
    };
    const ids = [
      provider.model,
      ...fromApi.map((item) => item.id),
      ...(preset?.models ?? []),
    ];
    return [...new Set(ids)].map((id) => ({ id, label: labelOf(id) }));
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
    if (/\s/.test(pendingKey.trim())) {
      setMessage("API Key 里不能有空格或换行，请重新复制一次。");
      return;
    }
    if (pendingKey.trim().length < 20) {
      setMessage(`这个 Key 只有 ${pendingKey.trim().length} 个字符，明显不完整，请重新复制。`);
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
      // 新加的模型在列表最上面，滚回去让它可见。
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      setMessage("已添加");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  if (!open) return null;

  const copyShare = async () => {
    try {
      const result = await api.get<{ share: string }>("/api/meeting/asr-config/export");
      try {
        await navigator.clipboard.writeText(result.share);
        setShareText("");
        setAsrMessage("已复制分享配置，发给队友即可（含 Key，注意别外传）。");
      } catch {
        // 192.168 这类非安全地址浏览器不允许写剪贴板，退化成手动复制。
        setShareText(result.share);
        setAsrMessage("浏览器不允许自动复制，请在下面文本框里按 Ctrl+C。");
      }
    } catch (caught) {
      setAsrMessage(errorMessage(caught));
    }
  };

  const showQr = async () => {
    try {
      const result = await api.get<{ share: string }>("/api/meeting/asr-config/export");
      const qrcode = await import("qrcode");
      setQrDataUrl(await qrcode.toDataURL(result.share, { width: 220, margin: 1 }));
    } catch (caught) {
      setAsrMessage(errorMessage(caught));
    }
  };

  const importShare = async () => {
    const match = /^asr:\/\/([^:]+):(.+)$/.exec(importText.trim());
    if (match === null) {
      setAsrMessage("格式不对，应该是 asr://productId:apiKey。");
      return;
    }
    setAsrMessage("导入中…");
    try {
      const next = await api.put<{ productId: string; keyHint: string; hasKey: boolean }>(
        "/api/meeting/asr-config",
        { productId: match[1], apiKey: match[2] },
      );
      setAsr(next);
      setAsrProductId(next.productId);
      setImportText("");
      setAsrMessage(`已导入 productId ${next.productId}，Key ${next.keyHint}。`);
    } catch (caught) {
      setAsrMessage(errorMessage(caught));
    }
  };

  const saveAsr = async () => {
    if (asrProductId.trim() === "") {
      setAsrMessage("请先填 productId（DUI 控制台创建产品后生成）。");
      return;
    }
    if (asrKey.trim() !== "" && asrKey.trim().length < 12) {
      setAsrMessage("这个 apiKey 太短了，请重新复制。");
      return;
    }
    setAsrMessage("保存中…");
    try {
      const next = await api.put<{ productId: string; keyHint: string; hasKey: boolean }>(
        "/api/meeting/asr-config",
        { productId: asrProductId.trim(), apiKey: asrKey.trim() === "" ? undefined : asrKey.trim() },
      );
      setAsr(next);
      setAsrKey("");
      setAsrMessage("已保存，可以上传录音了。");
    } catch (caught) {
      setAsrMessage(errorMessage(caught));
    }
  };

  return (
    <div className="llm-mask" role="dialog" aria-modal="true">
      <div className="llm-panel llm-panel-narrow">
        <header className="llm-head">
          <div>
            <strong>模型</strong>
            <span>
              {view?.providers.find((provider) => provider.active) !== undefined
                ? `当前：${view?.providers.find((provider) => provider.active)?.name} · ${view?.providers.find((provider) => provider.active)?.model}`
                : "选择一个用来处理会议纪要的大模型"}
            </span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="llm-scroll" ref={scrollRef}>
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
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
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

              <div className="llm-asr">
                <strong>语音转写（思必驰）</strong>
                <div className="llm-asr-tabs">
                  <button
                    type="button"
                    className={asrTab === "import" ? "on" : ""}
                    onClick={() => setAsrTab("import")}
                  >
                    导入团队配置
                  </button>
                  <button
                    type="button"
                    className={asrTab === "manual" ? "on" : ""}
                    onClick={() => setAsrTab("manual")}
                  >
                    自己填写
                  </button>
                </div>

                {asrTab === "import" ? (
                  <>
                    <label>
                      粘贴队长发来的配置
                      <textarea
                        rows={3}
                        value={importText}
                        onChange={(event) => setImportText(event.target.value)}
                        placeholder="asr://279636026:60dec0ce..."
                      />
                    </label>
                    <div className="llm-asr-actions">
                      <button className="primary-button" type="button" onClick={() => void importShare()}>
                        导入
                      </button>
                      <button
                        className="link-button"
                        type="button"
                        onClick={() => void navigator.clipboard.readText().then(setImportText).catch(() => setAsrMessage("读不到剪贴板，请手动粘贴。"))}
                      >
                        从剪贴板读取
                      </button>
                      <span>{asrMessage !== "" ? asrMessage : asr?.hasKey === true ? `已配置 ${asr.keyHint}` : "未配置"}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      DUI 控制台 → 基础技术 → 创建产品 → 开通「录音文件长语音转写」 → 服务授权填 IP 白名单 → 生成 apiKey。
                    </p>
                    <label>
                      productId
                      <input
                        value={asrProductId}
                        onChange={(event) => setAsrProductId(event.target.value)}
                        placeholder="例如 278578090"
                      />
                    </label>
                    <label>
                      apiKey
                      <input
                        type="password"
                        value={asrKey}
                        onChange={(event) => setAsrKey(event.target.value)}
                        placeholder={asr?.hasKey === true ? `已保存 ${asr.keyHint}，留空则不修改` : "粘贴 apiKey"}
                      />
                    </label>
                    <div className="llm-asr-actions">
                      <button className="primary-button" type="button" onClick={() => void saveAsr()}>
                        保存
                      </button>
                      {asr?.hasKey === true ? (
                        <>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => {
                              setAsrMessage("测试中…");
                              void api
                                .post<{ ok: boolean; note: string }>("/api/meeting/asr-config/test")
                                .then((result) => setAsrMessage(result.note))
                                .catch((caught) => setAsrMessage(errorMessage(caught)));
                            }}
                          >
                            测试连接
                          </button>
                          <button className="secondary-button" type="button" onClick={() => void copyShare()}>
                            复制分享配置
                          </button>
                          <button className="secondary-button" type="button" onClick={() => void showQr()}>
                            二维码
                          </button>
                        </>
                      ) : null}
                      <span>{asrMessage !== "" ? asrMessage : asr?.hasKey === true ? "已配置" : "未配置"}</span>
                    </div>
                    {shareText !== "" ? (
                      <textarea
                        readOnly
                        value={shareText}
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.currentTarget.select()}
                      />
                    ) : null}
                    {qrDataUrl !== "" ? (
                      <div className="llm-asr-qr">
                        <img src={qrDataUrl} alt="分享配置二维码" />
                        <span>同一串内容，扫描后复制到队友的应用里</span>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              {view?.envAvailable === true ? (
                <p className="llm-note">
                  服务器还配了一个默认 Key（环境变量）。你自己的模型优先；没有配时才用它——
                  多人共用时请各自添加自己的 Key，否则会消耗部署者的额度。
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
        {freeform ? (
          <input
            value={model}
            placeholder="模型名"
            onChange={(event) => setModel(event.target.value)}
          />
        ) : (
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            {preset.models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
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
