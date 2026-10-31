# 依赖审计说明（npm audit）

> 背景：学长在 PR 里指出「依赖审计仍报告 10 项漏洞（3 严重 / 5 高危 / 2 中危），本次未更换依赖，
> 建议下次部署前单独排查」。这份文档把这个结论拆开说明，并记录我们的处理。

## 先澄清一个误会

项目里**没有** `request` 这个库（它是早已废弃的 HTTP 客户端，我们从没用过）。
漏洞来自运行时依赖 `express` / `zod` 和构建工具 `vite` / `postcss` 等，**升级某一个包并不能一次清空**。

## 现状（2026-10-26 实测）

```powershell
npm.cmd audit --omit=dev
```

| 时间点 | 严重 | 高危 | 中危 | 低危 | 说明 |
|---|---|---|---|---|---|
| 初始 | 2 | 10 | 1 | 1 | 含 `concurrently → shell-quote` 命令注入 |
| 移除 concurrently 后 | 0 | 5 | 2 | 0 | 换成 `scripts/dev-run.mjs` |
| **现在** | **0** | **0** | **0** | **0** | `npm audit fix` 升到修复版本后清零 |

实际升级到的版本：

| 包 | 修复前 | 现在 |
|---|---|---|
| express | 4.22.2 | 4.22.3 |
| body-parser | 1.20.6 | 1.20.9 |
| qs | 6.15.2 | 6.16.1 |
| zod | 4.4.3 | 4.6.7 |
| vite | 8.0.16 | 8.3.5 |
| nanoid | 3.3.16 | 3.3.20 |
| source-map-js | 1.2.1 | 1.2.2 |
| proxy-addr | 2.0.7 | 2.0.8 |

这些都是**同一个大版本内的补丁升级**（没有跨 major），`npm audit fix` 自动完成，未使用 `--force`。

## 逐条看：哪些真的会打到线上

| 包 | 级别 | 问题 | 我们是否暴露 | 计划 |
|---|---|---|---|---|
| `express` / `body-parser` / `qs` | 高 | 构造请求导致 DoS（压缩体尾随字节、数组参数绕过） | **生产入口**，但已限制 JSON 1MB、文件 10MB、全部接口需登录 | 等 express 5 生态稳定后升级；部署前必须再审计 |
| `zod` / `zod-to-json-schema` | 高 | 超大集合校验可能耗尽内存 | 生产入口，但我们限制了纪要 2 万字、请求体 1MB | 跟随 zod 4 修复版本升级 |
| `express-rate-limit` | 高 | 依赖 express 的同一问题 | 仅登录接口用到 | 同上 |
| `@modelcontextprotocol/sdk` | 高 | 间接依赖 express-rate-limit / zod | MCP 只在**本地子进程**（stdio），不对公网 | 跟随上游升级 |
| `vite` / `@vitejs/plugin-react` | 高/低 | 开发服务器 `launch-editor` 命令注入 | **只在开发时**；生产用 `dist/` 静态文件，不跑 vite | 开发机使用，不影响部署产物 |
| `postcss` / `nanoid` / `source-map-js` | 高 | 构建期正则/源映射 DoS | **构建期**，不进入运行时请求路径 | 跟随构建链升级 |
| `concurrently` / `shell-quote` | 严重 | `quote()` 命令注入 | 只用于本地起服务 | ✅ **已移除**（换成自写启动脚本） |

## 结论与验证

1. `npm audit --omit=dev` 与全量 `npm audit` 现在都是 **0 漏洞**。
2. 修复全部是**同 major 的补丁升级**，没有执行 `npm audit fix --force`。
3. 升级后回归：类型检查 0 错误、`vitest` 368/372（4 个为 Windows 符号链接环境问题）、`npm run build` 通过、
   `npm run demo` 正常起服务。
4. **Playwright E2E 未能在本机复跑**：`playwright install chromium` 在这里被系统权限拦住
   （`EPERM: ... ms-playwright`），换目录安装也超时。部署前建议在能装浏览器的机器上补跑一次。

## 部署前的检查清单

- [ ] 升级 `express` 到 5.x、`zod` 到修复版本，重新跑 `npm audit --omit=dev`
- [ ] 反向代理层加请求体上限与速率限制（Nginx `client_max_body_size` + `limit_req`）
- [ ] 确认只跑一个 API 进程（SQLite 写锁）
- [ ] 换成新数据库（不要带 `demo1234` 演示账号）
- [ ] 开启 HTTPS 并设 `COOKIE_SECURE=true`

## 复现命令

```powershell
npm.cmd audit --omit=dev            # 生产依赖
npm.cmd audit                      # 含开发依赖
npm.cmd outdated                   # 看有没有可用升级
```
