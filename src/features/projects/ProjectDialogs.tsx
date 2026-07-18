import { useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Link2, Plus, Users } from "lucide-react";

import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import type { ProjectDetail, TeamMember } from "../../types";

interface CreateProjectDialogProps {
  teamMembers: TeamMember[];
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
}

export function CreateProjectDialog({ teamMembers, onClose, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await api.post<ProjectDetail>("/api/projects", {
        name,
        description,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        memberUserIds: selected,
      });
      onCreated(created);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建项目" onClose={onClose} width="large">
      <form className="modal-body project-form" onSubmit={submit}>
        <div className="form-grid two-columns">
          <label className="span-two">项目名称<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} autoFocus /></label>
          <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label>结束日期<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
          <label className="span-two">项目说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={10000} /></label>
        </div>
        <fieldset className="member-picker">
          <legend><Users size={16} /> 选择项目成员</legend>
          <p>创建者会自动加入，其他团队成员按需选择。</p>
          <div className="member-options">
            {teamMembers.map((member) => {
              const checked = selected.includes(member.userId);
              return (
                <label key={member.userId} className={checked ? "selected" : ""}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelected((current) => checked ? current.filter((id) => id !== member.userId) : [...current, member.userId])}
                  />
                  <span className="avatar">{member.displayName.slice(0, 1)}</span>
                  <span><strong>{member.displayName}</strong><small>@{member.username}</small></span>
                  {checked ? <Check size={17} /> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
        {error ? <p className="form-error">{error}</p> : null}
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={busy}><Plus size={16} />{busy ? "创建中…" : "创建项目"}</button>
        </footer>
      </form>
    </Modal>
  );
}

interface InviteDialogProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

interface CreatedInvite {
  id: string;
  projectId: string;
  code: string;
  expiresAt: string;
  revision: number;
}

export function InviteDialog({ projectId, projectName, onClose }: InviteDialogProps) {
  const [invite, setInvite] = useState<CreatedInvite>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const expiry = useMemo(
    () => invite ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(invite.expiresAt)) : "",
    [invite],
  );

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ invite: CreatedInvite }>(`/api/projects/${projectId}/invites`);
      setInvite(result.invite);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    await navigator.clipboard.writeText(invite.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal title="邀请项目成员" onClose={onClose} width="small">
      <div className="modal-body invite-dialog">
        <span className="dialog-icon"><Link2 size={21} /></span>
        <h3>{projectName}</h3>
        <p>新邀请码会立即使旧码失效，2 小时内可由多名已注册用户兑换。</p>
        {invite ? (
          <>
            <button className="invite-code" type="button" onClick={copy} aria-label="复制邀请码">
              <strong>{invite.code}</strong>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <small>有效至 {expiry}</small>
          </>
        ) : (
          <button className="primary-button invite-create" type="button" onClick={create} disabled={busy}>
            <Plus size={16} />{busy ? "生成中…" : "生成六位邀请码"}
          </button>
        )}
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

interface RedeemInviteScreenProps {
  displayName: string;
  onRedeemed: (projectId: string) => void;
  onLogout: () => void;
}

export function RedeemInviteScreen({ displayName, onRedeemed, onLogout }: RedeemInviteScreenProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ projectId: string }>("/api/project-invites/redeem", { code });
      onRedeemed(result.projectId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="join-page">
      <section>
        <div className="auth-brand">研程</div>
        <span className="dialog-icon"><Users size={22} /></span>
        <h1>{displayName}，加入你的项目</h1>
        <p>输入项目成员提供的六位数字邀请码。兑换后会同时加入固定团队与对应项目。</p>
        <form onSubmit={submit}>
          <input className="join-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" aria-label="六位项目邀请码" required autoFocus />
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>{busy ? "正在验证…" : "加入团队与项目"}</button>
        </form>
        <button className="text-button" type="button" onClick={onLogout}>退出当前账号</button>
      </section>
    </main>
  );
}
