# 研程 v2

面向 3-8 人大学生创新团队和研究生课题组的局域网项目管理系统。默认工作区是甘特图，核心目标是把比赛、科研任务、成员投入、截止节点和版本化资料放在同一条可协作的时间线上。

v2 是一次性重建版本，不读取或迁移 v1 业务数据。上线前请离线保留旧构建和旧数据库。

## 核心能力

- 固定团队：首个账号使用部署初始化码注册，后续账号使用注册邀请码；项目邀请码可将已注册用户加入团队和项目。
- 平权项目：创建项目时选择成员，任一项目成员都可维护任务、邀请成员和验收成果。
- 真实排期：阶段、父子任务、成员分工、依赖、里程碑、周期任务和模板统一显示在甘特图。
- 明确责任：每条成员分工有独立日期窗口、预计工时、执行状态和完成比例；进展记录不可变。
- 冲突计算：按最早截止优先，在个人可用时段和每周投入上限内虚拟分配剩余工时，标出无法分配、逾期、缺少可用时间和依赖倒挂。
- 验收闭环：任务或里程碑满足成员进度和必需交付物后进入待验收；任一成员可验收，完成后需显式重新打开。
- 资料沉淀：Markdown 和上传文件统一按版本管理，记录 SHA-256、上传者、MIME、原文件名和版本说明；恢复旧版会创建新版本。
- 生命周期：任务、项目和资料支持归档；删除后进入 30 天回收站，可恢复或二次确认永久删除。
- 实时协作：WebSocket 广播在线状态、拖拽锁、影子位置和实体失效；修订冲突返回最新实体。
- 隐私：个人可用时间的私人备注仅本人可读，项目成员只看到忙闲区间、容量和冲突结果。

## 技术栈

- React 19、Vite 8、TypeScript
- Express、WebSocket (`ws`)
- Node.js 24 内置 `node:sqlite`
- Zod 共享契约
- Vitest、Supertest、Playwright

数据库启用 WAL、外键和事务。会话使用 `HttpOnly`、`SameSite=Lax` Cookie；HTTPS 模式下必须启用 `Secure`。

## 本地开发

要求 Node.js 24 或更新版本。

```powershell
npm ci
npm run dev
```

开发环境默认值：

- 前端：`http://localhost:5173/`
- API：`http://localhost:4000/`
- 首个账号初始化码：`development-bootstrap-code`
- 数据库：`data/v2/app.sqlite`
- 上传目录：`data/v2/uploads`

开发默认密钥仅用于本机开发，不能用于生产环境。

### 注册与加入项目

1. 全新数据库的第一个账号在注册页输入 `BOOTSTRAP_CODE`。
2. 后续账号先使用服务器生成的注册邀请码完成账号注册：

```powershell
npm run invite:create -- --created-by first_username
```

3. 任一项目成员在应用中生成六位项目邀请码。
4. 新账号兑换项目邀请码后自动加入固定团队和对应项目。

项目邀请码有效 2 小时，新码会使旧码失效，也可由成员提前撤销。失败兑换按账号和 IP 限制为 10 分钟内最多 5 次。

## 常用命令

```text
npm run dev          启动前后端开发服务
npm run typecheck    检查前后端 TypeScript
npm run build        构建前端和生产服务
npm test             运行 v2 单元与 API 集成测试
npm run test:e2e     运行双账号桌面端流程
npm run check        执行类型、构建、测试、E2E 和生产依赖审计
npm start            启动已构建的生产服务
```

## Windows 局域网部署

### 1. 准备全新 v2 数据目录

停止 v1 服务后，将旧构建和旧数据库复制到离线目录。不要把 v1 数据库放到 v2 的 `DB_PATH`。

```powershell
npm ci
npm run build

$env:NODE_ENV = "production"
$env:HOST = "0.0.0.0"
$env:PORT = "4100"
$env:DB_PATH = "D:\TeamManager\v2\app.sqlite"
$env:UPLOAD_PATH = "D:\TeamManager\v2\uploads"
$env:BACKUP_PATH = "D:\TeamManager\v2\backups"
$env:MAX_UPLOAD_BYTES = "209715200"
$env:SESSION_SECRET = "replace-with-a-unique-random-secret-at-least-32-characters"
$env:BOOTSTRAP_CODE = "replace-with-a-unique-bootstrap-code"
$env:COOKIE_SECURE = "false"
$env:TRUST_PROXY_HOPS = "0"

npm start
```

同一局域网内通过 `http://主机IP:4100/` 访问。Windows 防火墙只应向可信局域网放行该端口。

生产启动会检查配置、数据库目录、上传目录写权限和可用空间；每次上传前还会按单文件上限再次检查空间。上传目录不能位于 `dist` 或 `public` 内。

### 2. 可选 Caddy HTTPS

使用 [deploy/Caddyfile.example](deploy/Caddyfile.example) 时，应用只监听回环地址：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4100"
$env:COOKIE_SECURE = "true"
$env:TRUST_PROXY_HOPS = "1"
npm start
```

Caddy 自动代理普通 HTTP 和 WebSocket。示例使用内部 CA，需让团队设备信任 Caddy 根证书，并把示例主机名解析到局域网主机。若改用正式域名证书，删除 `tls internal`。

所有生产配置项见 [deploy/team-project-manager-v2.env.example](deploy/team-project-manager-v2.env.example)。应用不会自动读取该文件；请由 PowerShell、服务管理器或部署平台将其注入进程环境。

## 配置

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NODE_ENV` | `development`、`test` 或 `production` | `development` |
| `HOST` | 监听地址；直接局域网使用 `0.0.0.0` | `0.0.0.0` |
| `PORT` | 服务端口 | `4000` |
| `DB_PATH` | v2 SQLite 文件 | `data/v2/app.sqlite` |
| `UPLOAD_PATH` | 随机存储名的上传目录 | `data/v2/uploads` |
| `BACKUP_PATH` | 离线备份目录 | `data/v2/backups` |
| `MAX_UPLOAD_BYTES` | 单文件上限，默认 200 MB | `209715200` |
| `SESSION_SECRET` | 会话签名密钥，生产至少 32 字符 | 无生产默认值 |
| `BOOTSTRAP_CODE` | 全新实例首个账号初始化码，生产至少 12 字符 | 无生产默认值 |
| `COOKIE_SECURE` | HTTPS 为 `true`，直接 HTTP 为 `false` | 生产必须显式设置 |
| `TRUST_PROXY_HOPS` | Caddy 单层反代为 `1`，直连为 `0` | `0` |

## 离线备份与恢复

系统不启用自动备份。备份和恢复都必须在生产服务停止后执行，命令会通过部署锁拒绝与运行中的服务并发操作。

### 创建备份

```powershell
npm run backup:v2 -- --name before-release-2026-07-18
```

备份目录包含：

- 一致性 SQLite 快照 `database.sqlite`
- 所有被数据库引用的上传文件
- `manifest.json` 文件清单、大小和 SHA-256
- 数据库迁移版本与校验信息

### 恢复备份

```powershell
npm run restore:v2 -- --from before-release-2026-07-18 --confirm RESTORE_V2_BACKUP
```

`--from` 可以是 `BACKUP_PATH` 下的目录名，也可以是绝对路径。恢复前会验证清单、文件集合、SHA-256、SQLite 完整性和迁移校验；成功替换前会暂存现有数据库与上传目录，失败时自动回滚。

## 上线与回退

1. 停止 v1，离线复制旧构建、旧数据库和旧上传资料。
2. 使用新的 `DB_PATH` 与 `UPLOAD_PATH` 初始化 v2。
3. 注册首个账号，建立测试项目，验证邀请、拖拽、上传、验收和备份恢复。
4. 验证通过后再让团队开始录入正式数据。
5. 若验证失败，停止 v2，恢复旧构建、旧数据库和旧上传目录；不要尝试把 v2 数据库交给 v1。

## 数据与安全边界

- 一个部署实例只服务一个固定团队。
- 非项目成员无法读取项目排期、资料或成员可用时间摘要。
- 上传使用流式写入和随机存储名；下载必须鉴权并强制附件返回。
- 所有业务修改写入活动日志，个人可用时间私人备注不进入项目日志。
- 所有可变实体使用 `revision` 做乐观并发控制；冲突返回 `409` 与最新数据。
- v2 冲突引擎只计算当前项目，不做跨项目容量冲突。

## 项目结构

```text
src/                    React 功能模块与桌面端工作区
server/config/          环境配置
server/db/              node:sqlite、迁移与数据库适配
server/modules/         鉴权、项目、排期、可用时间、资料、生命周期等领域模块
server/realtime/        WebSocket 在线状态与拖拽锁
server/cli/             注册邀请、离线备份与恢复
shared/                 前后端共享 Zod 契约
tests/client/           前端纯逻辑测试
tests/server/           单元与 API/实时集成测试
tests/e2e/              双账号 Playwright 工作流
deploy/                 生产环境和可选反向代理样例
```
