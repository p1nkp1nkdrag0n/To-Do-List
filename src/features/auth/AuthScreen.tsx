import { useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, Users } from "lucide-react";

import { api, errorMessage } from "../../lib/api";
import type { AuthState } from "../../types";

interface AuthScreenProps {
  onAuthenticated: (auth: AuthState) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [bootstrap, setBootstrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        await api.post("/api/auth/register", {
          username,
          displayName,
          password,
          ...(registrationCode
            ? bootstrap
              ? { bootstrapCode: registrationCode }
              : { registrationInviteCode: registrationCode }
            : {}),
        });
      }
      const auth = await api.post<AuthState>("/api/auth/login", { username, password });
      onAuthenticated(auth);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-context">
        <div className="auth-brand">研程</div>
        <h1>比赛与科研任务排期</h1>
        <p>让固定小团队在同一条时间线上明确负责人、投入工时、交付节点与资料版本。</p>
        <ul>
          <li><span><Users size={18} /></span>3–8 人固定团队协作</li>
          <li><span><LockKeyhole size={18} /></span>局域网部署，资料留在团队主机</li>
        </ul>
      </section>
      <section className="auth-panel">
        <div className="auth-tabs" role="tablist">
          <button className={mode === "login" ? "active" : ""} type="button" onClick={() => setMode("login")}>登录</button>
          <button className={mode === "register" ? "active" : ""} type="button" onClick={() => setMode("register")}>注册账号</button>
        </div>
        <form onSubmit={submit}>
          <h2>{mode === "login" ? "进入团队工作区" : "创建个人账号"}</h2>
          {mode === "register" ? (
            <label>
              显示名称
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} autoComplete="name" />
            </label>
          ) : null}
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={32} autoComplete="username" />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "register" ? 8 : 1} autoComplete={mode === "register" ? "new-password" : "current-password"} />
          </label>
          {mode === "register" ? (
            <>
              <label>
                注册邀请码或初始化码
                <input value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} autoComplete="one-time-code" />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={bootstrap} onChange={(event) => setBootstrap(event.target.checked)} />
                这是首次部署的初始化码
              </label>
            </>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>
            {busy ? "正在处理…" : mode === "login" ? "登录" : "注册并登录"}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}
