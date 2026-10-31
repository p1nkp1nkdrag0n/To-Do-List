/**
 * 注册邀请码：原来只能敲命令行生成，这里做成页面。
 * 注意：明文只显示一次（服务端只存哈希），关掉就再也看不到，只能重新生成。
 */
import { useCallback, useEffect, useState } from "react";

import { Copy, Plus, Trash2, X } from "lucide-react";

import { api, errorMessage } from "../../lib/api";

interface RegistrationInvite {
  id: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revision: number;
  state: "active" | "used" | "revoked" | "expired";
}

const STATE_LABEL: Record<RegistrationInvite["state"], string> = {
  active: "可用",
  used: "已使用",
  revoked: "已撤销",
  expired: "已过期",
};

export function RegistrationInvitesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [invites, setInvites] = useState<RegistrationInvite[]>([]);
  const [freshCode, setFreshCode] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ invites: RegistrationInvite[] }>(
        "/api/team/registration-invites",
      );
      setInvites(result.invites);
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setFreshCode("");
      setMessage("");
      void load();
    }
  }, [open, load]);

  const create = async () => {
    setBusy("生成中…");
    setMessage("");
    try {
      const result = await api.post<{
        invite: { code: string; expiresAt: string };
      }>("/api/team/registration-invites", {});
      setFreshCode(result.invite.code);
      await load();
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const revoke = async (invite: RegistrationInvite) => {
    setBusy("撤销中…");
    try {
      await api.delete(`/api/team/registration-invites/${invite.id}`, {
        expectedRevision: invite.revision,
      });
      await load();
      setMessage("已撤销");
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("已复制");
    } catch {
      setMessage("复制失败，请手动选中");
    }
  };

  if (!open) return null;

  return (
    <div className="llm-mask" role="dialog" aria-modal="true">
      <div className="llm-panel llm-panel-narrow">
        <header className="llm-head">
          <div>
            <strong>注册邀请码</strong>
            <span>凭这个码才能注册新账号；一次性、24 小时有效</span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="llm-scroll">
          {freshCode !== "" ? (
            <div className="invite-fresh">
              <p>新码（只显示这一次，关掉就看不到了）</p>
              <div className="invite-fresh-row">
                <code>{freshCode}</code>
                <button className="icon-button" type="button" title="复制" onClick={() => void copy(freshCode)}>
                  <Copy size={14} />
                </button>
              </div>
            </div>
          ) : null}

          {invites.length === 0 ? (
            <p className="llm-empty">还没有生成过邀请码。</p>
          ) : null}

          {invites.map((invite) => (
            <div key={invite.id} className="invite-row">
              <div className="invite-row-main">
                <span className={`invite-state state-${invite.state}`}>
                  {STATE_LABEL[invite.state]}
                </span>
                <span className="invite-time">
                  创建 {new Date(invite.createdAt).toLocaleString("zh-CN")}
                  {" · "}
                  到期 {new Date(invite.expiresAt).toLocaleString("zh-CN")}
                </span>
              </div>
              {invite.state === "active" ? (
                <button
                  className="icon-button"
                  type="button"
                  title="撤销这个码"
                  disabled={busy !== ""}
                  onClick={() => void revoke(invite)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <footer className="llm-foot llm-foot-plain">
          <span className="llm-status">{message}</span>
          <button className="primary-button" type="button" disabled={busy !== ""} onClick={() => void create()}>
            <Plus size={14} /> 生成新邀请码
          </button>
        </footer>
      </div>
    </div>
  );
}
