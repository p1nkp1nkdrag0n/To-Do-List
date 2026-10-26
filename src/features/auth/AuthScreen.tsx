import { useEffect, useState, type FormEvent } from "react";
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
import { api, ApiError, errorMessage } from "../../lib/api";
import type { AuthState } from "../../types";
import { AsciiFlowCanvas } from "./AsciiFlowCanvas";
import { FirstRunGuide } from "./FirstRunGuide";

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
  /** null = 还不知道；true = 空库，走首启向导。 */
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ needsBootstrap: boolean }>("/api/auth/bootstrap-status")
      .then((result) => {
        if (!cancelled) setNeedsBootstrap(result.needsBootstrap);
      })
      .catch(() => {
        if (!cancelled) setNeedsBootstrap(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 把后端返回的字段错误翻成一句中文（用户名最常见）。 */
  const readableError = (caught: unknown): string => {
    if (caught instanceof ApiError && caught.fieldErrors !== undefined) {
      const field = caught.fieldErrors;
      if (field.username !== undefined) {
        return "用户名只能用字母、数字、下划线、点或短横线（3–32 位），不能用中文。";
      }
      if (field.password !== undefined) {
        return "密码至少 8 位，且不能超过 72 个字节。";
      }
      if (field.displayName !== undefined) {
        return "显示名称不能为空，最多 80 个字。";
      }
      const first = Object.values(field)[0]?.[0];
      if (first !== undefined) return first;
    }
    return errorMessage(caught);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (needsBootstrap === true) {
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
          setError("用户名只能用字母、数字、下划线、点或短横线（3–32 位），不能用中文。");
          return;
        }
        if (password.length < 8) {
          setError("密码至少 8 位。");
          return;
        }
        if (password !== confirmPassword) {
          setError("两次输入的密码不一致");
          return;
        }
        const auth = await api.post<AuthState>("/api/auth/bootstrap", {
          username,
          displayName,
          password,
        });
        onAuthenticated(auth);
        return;
      }
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
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <AsciiFlowCanvas />
      <FirstRunGuide />
      <section className="auth-panel">
        <BrandMark auth />
        {needsBootstrap === true ? (
          <div className="auth-wizard">
            <strong>欢迎使用</strong>
            <span>这台设备还没有账号，先创建一个管理员</span>
          </div>
        ) : (
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
        )}
        <form aria-label={mode === "login" ? "登录" : "注册账号"} onSubmit={submit}>
          {mode === "register" || needsBootstrap === true ? (
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
                minLength={mode === "register" || needsBootstrap === true ? 8 : 1}
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
          {needsBootstrap === true ? (
            <label className="auth-field">
              <span>确认密码</span>
              <span className="auth-input-shell">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  type={passwordVisible ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="再输入一次密码"
                />
              </span>
            </label>
          ) : null}
          {mode === "register" && needsBootstrap !== true ? (
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
            ) : needsBootstrap === true ? (
              <>
                创建并开始
                <ArrowRight size={17} />
              </>
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
