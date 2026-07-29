import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  TicketCheck,
  UserRound,
} from "lucide-react";

import { BrandMark } from "../../components/BrandMark";
import { api, errorMessage } from "../../lib/api";
import type { AuthState } from "../../types";
import { AsciiFlowCanvas } from "./AsciiFlowCanvas";

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
  const [passwordVisible, setPasswordVisible] = useState(false);
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
      <AsciiFlowCanvas />
      <section className="auth-panel">
        <BrandMark auth />
        <div className="auth-tabs" role="tablist">
          <button
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            role="tab"
            type="button"
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            role="tab"
            type="button"
            onClick={() => setMode("register")}
          >
            注册账号
          </button>
        </div>
        <form aria-label={mode === "login" ? "登录" : "注册账号"} onSubmit={submit}>
          {mode === "register" ? (
            <label className="auth-field">
              <span>显示名称</span>
              <span className="auth-input-shell">
                <UserRound size={18} aria-hidden="true" />
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                  maxLength={80}
                  autoComplete="name"
                  placeholder="团队中显示的名称"
                />
              </span>
            </label>
          ) : null}
          <label className="auth-field">
            <span>用户名</span>
            <span className="auth-input-shell">
              <UserRound size={18} aria-hidden="true" />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                minLength={3}
                maxLength={32}
                autoComplete="username"
                placeholder="请输入用户名"
              />
            </span>
          </label>
          <div className="auth-field">
            <label htmlFor="auth-password">密码</label>
            <span className="auth-input-shell">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                id="auth-password"
                type={passwordVisible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={mode === "register" ? 8 : 1}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                placeholder="请输入密码"
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                title={passwordVisible ? "隐藏密码" : "显示密码"}
                onClick={() => setPasswordVisible((current) => !current)}
              >
                {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </div>
          {mode === "register" ? (
            <>
              <label className="auth-field">
                <span>注册邀请码或初始化码</span>
                <span className="auth-input-shell">
                  <TicketCheck size={18} aria-hidden="true" />
                  <input
                    value={registrationCode}
                    onChange={(event) => setRegistrationCode(event.target.value)}
                    autoComplete="one-time-code"
                    placeholder="输入邀请码或初始化码"
                  />
                </span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={bootstrap} onChange={(event) => setBootstrap(event.target.checked)} />
                这是首次部署的初始化码
              </label>
            </>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>
            {busy ? (
              "正在处理…"
            ) : mode === "login" ? (
              <>
                <KeyRound size={17} />
                进入工作区
              </>
            ) : (
              <>
                注册并登录
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
      </section>
    </main>
  );
}
