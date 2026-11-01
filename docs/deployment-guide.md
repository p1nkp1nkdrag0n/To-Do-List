# 部署与数据维护

[返回项目首页](../README.md)

本文说明当前 v2 的运行、配置、备份和 Windows 打包方式。默认以一个实例服务一个团队；同一数据库只运行一个 API 实例。v1 数据库不能直接用于 v2，桌面版旧数据迁移也不转换 v1 业务数据。

## 选择运行方式

| 方式 | 入口 | 数据位置 |
| --- | --- | --- |
| 本地开发 | `npm run dev`，前端默认 5173、API 默认 4000 | 默认 `data/v2/` |
| 从源码部署 | `npm run build` 后 `npm start` | 由 `DB_PATH`、`UPLOAD_PATH`、`BACKUP_PATH` 指定 |
| Windows 便携目录 / 单文件 EXE | 运行构建产物中的启动脚本或 EXE | 由启动器选择持久目录，以控制台输出和已保存指针为准 |

源码部署与桌面启动器使用不同的配置入口，不能把某一方式的默认目录套用到另一种方式。

## 从源码部署

需要 Node.js 24+。在仓库目录执行 `npm ci`、`npm run build`。Windows 可信局域网可以在同一个 PowerShell 会话中配置并启动：

```powershell
$env:NODE_ENV = "production"
$env:HOST = "0.0.0.0"
$env:PORT = "4100"
$env:DB_PATH = "D:\TeamManager\v2\app.sqlite"
$env:UPLOAD_PATH = "D:\TeamManager\v2\uploads"
$env:BACKUP_PATH = "D:\TeamManager\v2\backups"
$env:MAX_UPLOAD_BYTES = "209715200"
$env:SESSION_SECRET = "replace-with-at-least-32-random-characters"
$env:BOOTSTRAP_CODE = "replace-with-a-unique-bootstrap-code"
$env:COOKIE_SECURE = "false"
$env:TRUST_PROXY_HOPS = "0"

# 启动前，将上面两项密钥占位值替换为自己生成并妥善保存的随机值。
npm start
```

两个占位值会被生产启动检查拒绝。`SESSION_SECRET` 至少 32 字符，首次生成后持久保存并在重启时复用；`BOOTSTRAP_CODE` 至少 12 字符，用于全新实例的首个账号。不要使用开发默认值。

同一局域网的成员访问 `http://主机IP:4100/`。健康检查路径是 `/healthz`；Windows 防火墙放行范围应限定为需要访问的可信网络。上传目录必须位于 `dist`、`public` 之外，备份目录与上传目录应使用不同目录树。

### 配置来源与完整变量

服务入口 `server/v2.ts` 会读取当前工作目录的 `.env`，已有进程环境变量优先。仓库中的 [环境示例](../deploy/team-project-manager-v2.env.example) 不会自动生效；需要改为自己的配置并注入进程，或保存为工作目录的 `.env`。

**注册邀请、备份、恢复 CLI 当前不自动读取 `.env`。** 使用这些命令时，须显式设置与目标实例一致的环境变量；在其他终端直接运行，可能指向默认的开发目录。不要把真实 `.env`、数据库或 Key 提交到仓库。

| 变量 | 说明 | 未配置时 |
| --- | --- | --- |
| `NODE_ENV` | `development` / `test` / `production` | `development` |
| `HOST` | 服务监听地址 | `0.0.0.0` |
| `PORT` | API / 构建后页面服务端口 | `4000` |
| `DB_PATH` | SQLite 文件；相对路径基于进程工作目录 | `data/v2/app.sqlite` |
| `UPLOAD_PATH` | 上传文件目录 | `data/v2/uploads` |
| `BACKUP_PATH` | 离线备份目录 | `data/v2/backups` |
| `MAX_UPLOAD_BYTES` | 普通文件上传上限，单位字节 | `209715200`（200 MiB） |
| `SESSION_SECRET` | 会话签名密钥 | 仅开发环境有默认值 |
| `BOOTSTRAP_CODE` | 首个账号初始化码 | 仅开发环境有默认值 |
| `COOKIE_SECURE` | HTTPS 设为 `true`，直接 HTTP 设为 `false` | 生产必须显式设置 |
| `TRUST_PROXY_HOPS` | 单层 Caddy 反代为 `1`，直连为 `0` | `0` |

普通上传配置不代表所有会议接口的限制：纪要文件解析另有 10 MB 请求上限，音频接口另有自己的校验。

### 可选 HTTPS 反向代理

仓库提供 [Caddy 示例](../deploy/Caddyfile.example)。使用该示例时，应用只监听回环地址：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4100"
$env:COOKIE_SECURE = "true"
$env:TRUST_PROXY_HOPS = "1"
npm start
```

保留前面配置的数据库路径和密钥。示例使用内部 CA，需要让团队设备信任该证书，并将示例主机名解析到服务器。正式域名使用公开证书时相应调整 Caddy 配置。普通 HTTP 和 WebSocket 都经过该代理。

## 首次使用与成员加入

1. 全新数据库进入账号创建向导，使用该实例的初始化码建立首个账号。
2. 创建项目，按实际成员填写可用时间。
3. 侧栏「注册邀请码」用于创建账号；项目邀请码用于让已有账号加入项目。

部署者也可通过 CLI 生成注册邀请码。以下命令中的用户名应替换为已有账号，并使用同一实例的进程环境配置：

```powershell
npm run invite:create -- --created-by first_username
```

成员自己的模型和 ASR 配置保存在 `DB_PATH` 所在目录下的 `llm/`、`asr/`。共享模型兜底需要部署者显式设置 `LLM_ALLOW_SHARED_FALLBACK=1`；通常直接让成员在页面配置各自的供应商即可。

## 离线备份与恢复

系统不自带定时备份。先正常停止目标实例，在已加载该实例环境变量的终端中执行；备份和恢复会检查部署锁。

创建备份（再次备份时换用新的名称）：

```powershell
npm run backup:v2 -- --name before-upgrade
```

需要恢复时，再执行下面的命令。`--from` 可以是 `BACKUP_PATH` 下的目录名或绝对路径：

```powershell
npm run restore:v2 -- --from before-upgrade --confirm RESTORE_V2_BACKUP
```

备份包包含一致性 SQLite 快照 `database.sqlite`、上传目录中的文件，以及带大小、SHA-256 和数据库迁移版本的 `manifest.json`。恢复会校验清单、文件、SQLite 完整性与迁移版本，在替换失败时回滚本次数据库和上传目录操作。

**业务备份包不包含全部部署配置。** `llm/`、`asr/`、服务环境变量、桌面启动器的 `config.json` 和数据目录指针需要另行安全备份；恢复业务备份不会恢复这些内容。迁移整台电脑或更换桌面版本前，应在停机后保留完整持久数据目录、配置和可用的旧程序副本。

不要通过手工删除 SQLite 的 WAL/SHM/journal 文件绕过迁移或备份检查。升级后先确认账号、项目、附件和模型配置均可读取，再清理旧副本。

## Windows 桌面程序

### 构建产物

在 Windows 的仓库根目录执行，单文件构建需要系统 `tar` 和 .NET Framework 4.x 的 C# 编译器：

```powershell
npm ci
npm run build
node scripts/package-portable.mjs
powershell -ExecutionPolicy Bypass -File packaging/single-exe/build.ps1
```

当前脚本将产物写到**仓库父目录**的 `release/`：便携目录为 `../release/ToDoList/`，单文件为 `../release/ToDoList.exe`。便携打包会清理该输出目录，应在独立构建目录运行，勿将运行中的实例或业务数据放在该位置。

便携目录含 `启动.cmd`；单文件 EXE 会解压独立程序版本，再启动同一套服务。正式分发需核对对应源码提交、文件 SHA-256 和干净环境验收结果，历史文档中的包名不能用于判断当前源码版本。

### 首启与数据目录

启动器自动选择 `4000` 或后续可用端口，在控制台显示访问地址、实际数据目录和初始化码，并尝试打开浏览器。它可能请求防火墙授权；主机需要持续运行，关闭启动控制台会停止服务。

默认持久根目录是 `%LOCALAPPDATA%\ToDoList`。显式设置 `TODOLIST_DATA_ROOT` 时必须是独立的绝对路径。已经保存的 `todolist-data-root.txt` 会记录所选根目录；按原布局迁移时也可能使用该目录下的 `storage/`。**以实际启动日志和指针为准。**

选定根目录下的布局为：

```text
<持久数据根>/
  config.json           启动器端口、会话配置等
  data/
    app.sqlite          账号、项目与排期
    uploads/            附件
    backups/            业务备份
    llm/                用户模型配置
    asr/                用户语音配置
```

权限未知、显式目录不可用、指针冲突或迁移锁存在时，启动器会停止。仅符合条件的默认目录权限失败才进入明确确认的回退流程，保存选择后供后续启动使用。

### 旧版 v2 目录迁移

先备份并正常关闭旧实例。控制台迁移会列出源、目标，要求选择源目录并输入 `MIGRATE` 确认；取消或非交互环境会停止，不启动空库。

高级用法可以显式设置 `TODOLIST_MIGRATE_FROM` 和 `TODOLIST_MIGRATION_OFFLINE=1`。源应是含 `config.json`、`data/` 的旧持久根目录。迁移保留原件，拒绝覆盖已有目标数据；程序解压目录、业务数据目录和迁移目标不能混为一处。

桌面迁移的实现细节与历史决策见[阶段记录](desktop-packaging.md)，文件系统保护见[解压安全说明](launcher-extraction-safety.md)。已具备控制台交互迁移，未提供 GUI 弹窗向导。完整 EXE 首启、同版本复用、覆盖升级、真实网络和签名仍需要单独验收。
