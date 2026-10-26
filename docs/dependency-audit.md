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
| 修复前 | 2 | 10 | 1 | 1 | 含 `concurrently → shell-quote` 的命令注入 |
| 修复后 | **0** | 10 | 1 | 1 | 已移除 `concurrently`，改用 `scripts/dev-run.mjs` |

**为什么不能 `npm audit fix`**：所有条目 `fixAvailable: false`——也就是说当前 npm registry 上的
**最新版本仍然带着这些问题**，官方还没发修复版本。`npm outdated` 也显示所有依赖已在最新范围。

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

## 结论

1. **没有「一条命令清空」的修复**：所有条目上游都还没发修复版本。
2. **严重级别的两项已经消除**（`concurrently` 链已移除）。
3. 剩下的高危集中在 `express` / `zod` 的 DoS 类问题——**它们的利用前提是服务对公网开放**。
4. 因此处置策略是：**比赛期间只在本机/局域网演示**；真要公网部署，先做下面这件事。

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
