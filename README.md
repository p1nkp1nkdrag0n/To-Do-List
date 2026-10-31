# TO DO LIST v2

## 开源许可与对应源码

本项目原创代码采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，
不包含“或任何更新版本”的授权。许可全文见 [LICENSE](LICENSE)。本软件不提供任何担保。
第三方依赖、Inter 字体和图标保留各自许可及原作者声明，详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [完整声明](licenses/npm-notices.txt)。

应用所有页面右下角的“关于 / 开源许可”打开 `/legal/`，无需登录即可阅读许可、第三方声明，
并下载**当前构建对应的源码包**。构建会将经过审阅并由 Git 跟踪的源码、构建脚本、锁文件和部署示例
打包到 `dist/legal/source-<SHA-256>.tar.gz`，以文件内容清单匹配实际版本，不使用可变的 `main` 链接。
新源码文件须先审阅并 `git add`；未跟踪的新源码会让构建失败。源码包不含 `.git`、真实环境配置、
密钥、数据库、上传文件或备份。发布修改版时，请保留这个明显的免费源码入口并重新构建。

从下载的源码包构建：解压后进入 `to-do-list/`，使用 Node.js 24+ 执行 `npm ci`、
`npm run build`；构建使用包内 `SOURCE_MANIFEST.json`，不需要 Git。实际部署参数见下文。
如从源码包继续开发并新增文件，请先初始化 Git 仓库、删除旧的 `SOURCE_MANIFEST.json` 并审阅跟踪新文件。

发布前运行 `npm run licenses:check`。分发和部署时必须将整个 `dist/legal/` 与同次构建的客户端、
服务器端产物一起保留；不要只复制 JavaScript/CSS，也不要混用旧前端和新服务端。该检查会验证源码
哈希、完整许可、浏览器依赖声明以及字体原始字节。依赖更新后另运行 `npm run licenses:update`
并审阅声明差异。操作系统、Node.js、反向代理及自行加入的组件需要独立保留它们的许可。

## 项目来源与修改说明

本项目基于 [p1nkp1nkdrag0n/To-Do-List](https://github.com/p1nkp1nkdrag0n/To-Do-List)
（AGPL-3.0-only）二次开发，原项目的版权与许可声明一并保留。本仓库是该项目的衍生版本，
依据 AGPL-3.0 第 5 条标注修改。

比赛与课题期间的主要改动：

- **会议纪要 → 排期**：上传纪要或粘贴文本，抽取任务、建立排期、检测容量/依赖冲突并给出修复方案，
  处理完自动跳转甘特图；支持在 AI 设置里为每个账号单独配置模型 Key。
- **MCP 工具层**：把排期能力封装为 MCP server（`server/mcp/`），编排器通过 stdio 调用，
  保证所有写操作走同一入口。
- **首次使用体验**：首启向导（空库创建管理员）、使用说明（侧栏八章帮助）、
  纪要人名与成员显示名称的一致校验提示、可用时间为 0 时的引导。
- **桌面分发**：便携目录与单文件 exe 打包脚本（`packaging/`），
  首次运行自解压、数据与程序分离、解压完整性校验。

这些改动的提交记录见 `git log`；上游仓库的合并请求与依赖审计过程记录在
`docs/delivery.md` 与 `docs/dependency-audit.md`。

面向 3-8 人大学生创新团队和研究生课题组的局域网项目管理系统。默认工作区是甘特图，核心目标是把比赛、科研任务、成员投入、截止节点和版本化资料放在同一条可协作的时间线上。

v2 是一次性重建版本，不读取或迁移 v1 业务数据。上线前请离线保留旧构建和旧数据库。

## 成果索引

- 技术报告：[Word](docs/会议排期系统技术报告.docx) · [PDF](docs/会议排期系统技术报告.pdf)
- 验证记录：[验证清单](docs/验证清单.md)
- 发布说明：[release-notes.md](release-notes.md)
- 关键截图：[实时工作区](docs/images/realtime-workspace.png) · [确认清单](docs/images/task-confirmation.png) · [资料库](docs/images/resource-library.png)
- 可执行文件：GitHub Releases 中的 `ToDoList-f960-交付版.exe`（125 MB，不进入 Git 历史）

## 会议 → 排期（本次新增）

把一段会议纪要（或 txt / docx / pdf 文件）变成真实排期，并自动修复冲突：

```
纪要 → 抽取任务（大模型）→ 建库/分工/依赖 → 冲突检测 → 自动重排 → 甘特图
```

- 入口：左侧「会议」→ 粘贴纪要或上传文件
- 支持撤销上一次自动调整；可锁定负责人（只延期、不换人）
- 大模型 Key 按用户隔离，在「手动 → AI 设置」里配置（DeepSeek / 硅基流动 / 通义 / 智谱 / Kimi / 自定义）
- 演示：`npm run demo`，然后「填入示例纪要」

细节与部署状态见 [docs/delivery.md](docs/delivery.md)，依赖审计见 [docs/dependency-audit.md](docs/dependency-audit.md)。

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
