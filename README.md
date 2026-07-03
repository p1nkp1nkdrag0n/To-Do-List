# 多人团队项目管理应用 v1

这是一个面向局域网部署的多人团队项目管理应用原型，包含团队模式、个人模式和项目知识库。团队模式以甘特图展示多人任务排期，个人模式展示个人日程，知识库保存项目资料，并支持个人日程提交到团队审批。

推荐部署方式是在办公室、实验室或家庭局域网内选一台电脑作为主机，构建前端后用 Node.js 启动服务，其他设备通过主机内网 IP 访问。

## 主要功能

- 账号系统：支持用户名、邮箱、密码和确认密码注册，支持登录和密码哈希存储。
- 多项目管理：用户可以创建多个项目，并在项目之间切换。
- 项目成员：不区分管理员和普通成员；每个项目成员都拥有完整项目管理权限，可以通过用户名添加或移除项目成员。
- 项目知识库：
  - 每个项目顶部都有“知识库”按钮。
  - 知识库采用分类 + 文档结构，正文使用 Markdown。
  - 所有项目成员可以查看、新增、编辑、删除分类和文档。
- 团队甘特图：
  - 支持一周、一月、一年三种量程。
  - 周从周一开始。
  - 月视图按自然月天数比例显示。
  - 年视图按 12 个自然月显示。
  - 任务条按日期比例占据时间轴宽度。
  - 项目成员可打开“显示个人日程”开关，将成员个人忙闲以只读条显示在团队甘特图中；关闭后只显示团队任务。
- 无限层级任务：
  - 任务可创建任意层级父子关系。
  - 支持展开、折叠、删除。
  - 状态固定为：待办、进行中、完成。
- 成员任务分配：
  - 每个成员使用不同颜色条显示工作安排。
  - 项目成员可以表单创建分配。
  - 项目成员可以在甘特图中拖拽任务条移动日期，也可以拖拽左右边缘调整开始/结束日期。
- 里程碑/Deadline：
  - 每个任务可添加多个里程碑。
  - 里程碑包含日期、标题和颜色。
  - 甘特图上会在对应日期显示彩色标志。
- 审批流：
  - 项目成员可以直接修改团队排期。
  - 成员仍可以提交任务时间/状态变更请求。
  - 成员可以把个人日程提交到团队，申请加入已有任务或创建新团队任务。
  - 任意项目成员可以批准或拒绝请求。
- 个人模式：
  - 支持日、周、月、年视图。
  - 日视图按小时展示，日程块支持拖拽。
  - 日程拖拽按 5 分钟吸附。
  - 团队任务会同步为个人全天事件。
  - 个人事件和团队事件允许并行存在，不做冲突拦截。
- 实时同步：
  - 后端通过 WebSocket 广播项目更新。
  - 多个浏览器登录不同账号时，可以看到项目数据刷新。

## 技术栈

- 前端：React + Vite
- 后端：Node.js + Express
- 数据库：SQLite 语义，本项目使用 `sql.js` 持久化到本地文件
- 实时通信：WebSocket，使用 `ws`
- 密码哈希：`bcryptjs`
- 图标：`lucide-react`
- 测试：Node.js 内置测试框架 + `supertest`

> 说明：原计划使用原生 SQLite 绑定，但当前环境编译 `better-sqlite3` 需要的 C++20 工具链不可用，所以项目改为 `sql.js`。数据库仍以 SQLite 文件形式持久化，默认路径为 `data/app.sqlite`。

## 项目结构

```text
.
├── start-lan.sh              # 一键局域网启动脚本
├── .env.lan.example          # 局域网部署环境变量模板
├── index.html                # Vite 前端入口
├── package.json              # 脚本和依赖
├── vite.config.js            # Vite 配置与 /api、/ws 代理
├── server/
│   ├── index.js              # 后端启动入口
│   ├── app.js                # Express API、权限、审批、业务逻辑
│   ├── db.js                 # SQLite/sql.js 数据库初始化与持久化
│   ├── realtime.js           # WebSocket 订阅与广播
│   ├── security.js           # 密码哈希、token 签发与校验
│   └── app.test.js           # 后端集成测试
├── src/
│   ├── main.jsx              # React 启动入口
│   ├── App.jsx               # 主应用、团队模式、个人模式、知识库、甘特图
│   ├── api.js                # 前端 API 与 WebSocket 客户端
│   ├── dateUtils.js          # 日期、时间轴、比例计算工具
│   └── styles.css            # 页面样式
├── scripts/
│   ├── start-lan.js          # 局域网运行入口，打印内网访问地址
│   └── seed-demo.js          # 演示数据生成脚本
└── deploy/
    ├── Caddyfile.example
    ├── team-project-manager.service
    ├── team-project-manager-backup.service
    ├── team-project-manager-backup.timer
    ├── team-project-manager.env.example
    └── backup-db.sh
```

## 运行逻辑

### 1. 用户与鉴权

用户通过 `/api/auth/register` 注册，通过 `/api/auth/login` 登录。注册接口使用四个字段：

- `username`：用户名。
- `email`：邮箱。
- `password`：密码。
- `confirmPassword`：确认密码。

后端会将密码用 `bcryptjs` 哈希后保存，并返回一个本地 token。

前端把 token 存在 `localStorage` 中。之后所有 `/api` 请求都会在请求头中带上：

```text
Authorization: Bearer <token>
```

后端在进入业务 API 前统一校验 token，并把当前用户挂载到请求对象上。

### 2. 项目和权限

每个项目都有独立成员列表。项目成员不再区分管理员和普通成员；只要属于该项目，就拥有完整项目管理权限。

项目成员可以：

- 修改项目名称。
- 添加或移除项目成员。
- 创建、修改、删除任务。
- 创建、修改、删除任务分配。
- 创建、删除里程碑。
- 创建、修改、删除知识库分类和文档。
- 查看成员个人忙闲时间段。
- 审批成员请求。
- 管理自己的个人日程。
- 把个人日程提交给团队审批。

### 3. 数据模型

核心数据表包括：

- `users`：用户账号，包含用户名、邮箱、密码哈希和显示名。
- `projects`：项目。
- `project_members`：项目成员关系。
- `tasks`：任务，支持 `parent_id` 表达无限层级。
- `assignments`：任务分配，记录某个成员在某个任务上的开始/结束日期。
- `milestones`：任务里程碑。
- `personal_events`：个人日程，也保存由团队任务同步生成的全天事件。
- `change_requests`：审批请求。
- `knowledge_categories`：项目知识库分类。
- `knowledge_documents`：项目知识库文档，正文保存 Markdown 文本。

### 4. 团队甘特图逻辑

团队模式的时间轴由前端根据当前选中日期和量程计算：

- 周视图：显示当前日期所在自然周，周一到周日。
- 月视图：显示当前日期所在自然月，按真实天数显示。
- 年视图：显示当前日期所在自然年，按 12 个自然月显示。

任务分配条根据 `startDate`、`endDate` 和当前可见时间段计算百分比位置：

- `left` 表示距离当前时间段开始的比例。
- `width` 表示任务持续天数占当前时间段的比例。

项目成员拖拽任务条时，前端按当前视图宽度换算成天数偏移，再调用后端更新 `assignments`。

### 5. 个人日程逻辑

个人模式支持日、周、月、年：

- 日视图显示 24 小时网格。
- 普通个人事件可以拖拽。
- 拖拽时按 5 分钟吸附。
- 团队同步事件为只读全天事件。

当项目成员给成员创建团队任务分配时，后端会自动在该成员的个人日程中生成一条团队全天事件。更新或删除分配时，对应的个人团队事件也会同步更新或删除。

### 6. 知识库逻辑

知识库是项目级资料区，入口位于顶部项目标题旁的“知识库”按钮。进入后：

- 左侧显示分类和文档列表。
- 中间显示当前文档的 Markdown 预览。
- 右侧显示文档信息和审批列表。

知识库权限：

- 项目成员都可以读取当前项目知识库。
- 项目成员都可以直接新增、重命名、删除分类。
- 项目成员都可以直接新增、编辑、删除文档。

分类删除后，该分类下的文档不会被删除，会自动转为“未分类”。

Markdown 预览由前端按安全文本渲染，不执行文档中的 HTML。

### 7. 审批逻辑

成员提交的请求会进入 `change_requests` 表。当前支持五类请求：

- `assignment_update`：申请修改自己的团队任务时间或状态。
- `personal_to_team_assignment`：申请把个人日程加入已有团队任务。
- `personal_to_team_task`：申请把个人日程变成新的团队任务。
- `knowledge_document_create`：申请新增知识库文档。
- `knowledge_document_update`：申请编辑已有知识库文档。

任意项目成员批准请求后，后端会执行对应写入：

- 修改已有任务分配。
- 新增任务分配。
- 新建任务并新增任务分配。
- 新增知识库文档。
- 更新知识库文档。

项目成员拒绝请求时，只更新请求状态，不改变任务数据。

### 8. 实时同步逻辑

前端进入项目后，会通过 `/ws` 建立 WebSocket 连接，并发送订阅消息：

```json
{
  "type": "subscribe",
  "projectId": "项目 ID",
  "token": "登录 token"
}
```

后端校验用户是否属于该项目。通过后，项目内发生成员、任务、分配、里程碑、知识库或审批变化时，后端会广播：

```json
{
  "type": "project:update",
  "projectId": "项目 ID",
  "reason": "更新原因"
}
```

前端收到后会重新拉取项目详情、个人日程和当前项目知识库。

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发环境

```bash
npm run dev
```

启动后默认地址：

- 前端：`http://localhost:5173/`
- 后端：`http://localhost:4000/`

开发模式会同时启动：

- Vite 前端开发服务器。
- Express 后端服务器。

前端通过 `vite.config.js` 把 `/api` 和 `/ws` 代理到后端。

### 3. 生成演示数据

启动应用后，在另一个终端执行：

```bash
npm run seed:demo
```

如果演示账号已经存在，直接在应用运行时执行 `npm run seed:demo` 即可，脚本会登录已有账号继续创建新的演示项目。

脚本会创建一组演示账号、项目、任务树、成员排期、里程碑、知识库文档、个人日程和待审批请求。

演示账号：

```text
demo_kai / demo123456
demo_alice / demo123456
demo_bob / demo123456
demo_chen / demo123456
```

推荐先用 `demo_kai` 登录查看团队模式，再用另一个浏览器或隐私窗口登录 `demo_bob` 检查多人同步和个人模式。

## 局域网部署

运行要求：Node.js `>=22.12`，推荐 Node.js 24 LTS。

### 推荐：一键启动

在局域网主机上直接运行：

```bash
bash start-lan.sh
```

脚本会自动完成：

- 检查 Node.js 和 npm。
- 第一次运行时生成 `.env.lan` 和随机 `AUTH_SECRET`。
- 在缺少依赖或依赖变化时执行 `npm ci`。
- 在缺少构建产物或前端源码变化时执行 `npm run build`。
- 启动局域网服务，并打印其他设备可访问的内网地址。

打开应用后，直接用用户名、邮箱、密码和确认密码注册账号。

### 手动部署

如果你希望自己控制每一步，可以按下面流程手动执行。

#### 1. 准备配置

在作为局域网主机的电脑上复制配置模板：

```bash
cp .env.lan.example .env.lan
```

编辑 `.env.lan`，至少修改这一项：

```bash
AUTH_SECRET=一段随机长密钥
```

可以用下面的命令生成随机密钥：

```bash
openssl rand -base64 32
```

默认局域网配置如下：

```bash
NODE_ENV=lan
HOST=0.0.0.0
PORT=4000
DB_PATH=./data/app.sqlite
APP_URL=http://localhost:4000
```

说明：

- `HOST=0.0.0.0`：允许同一局域网内其他设备访问；如果改成 `127.0.0.1`，只能本机访问。
- `PORT=4000`：局域网访问端口，其他设备访问 `http://主机内网IP:4000/`。
- `DB_PATH=./data/app.sqlite`：数据库文件保存在项目目录下的 `data/`。
- `AUTH_SECRET`：token 签名密钥，保持不变可以让登录状态稳定；修改后旧 token 会失效。

#### 2. 安装依赖并构建前端

```bash
npm ci
npm run build
```

构建产物会输出到：

```text
dist/
```

#### 3. 启动局域网服务

```bash
npm run lan:start
```

启动后会在终端打印本机和局域网访问地址，例如：

```text
LAN server running at http://localhost:4000/
Open from other devices on the same LAN:
- http://192.168.1.23:4000/
```

同一 Wi-Fi 或有线局域网内的其他电脑、平板、手机，打开终端打印的内网地址即可使用。

如果其他设备打不开：

- 确认所有设备在同一个局域网内。
- 确认主机防火墙允许 TCP `4000` 端口入站。
- 确认路由器没有开启 AP 隔离、访客网络隔离或客户端隔离。
- 如果主机 IP 变化，重新查看 `npm run lan:start` 打印的新地址。

#### 4. 数据持久化和备份

局域网默认数据库文件：

```text
data/app.sqlite
```

数据库写入会先写同目录临时文件再原子替换目标文件。部署主机需要保证 `data/` 目录可写，并定期备份 `data/app.sqlite`。

可以直接复制数据库文件作为备份，也可以复用仓库里的备份脚本：

```bash
DB_PATH=./data/app.sqlite BACKUP_DIR=./backups ./deploy/backup-db.sh
```

## 公网服务器部署参考（可选）

局域网部署不需要 Caddy、域名、HTTPS 证书或 systemd 服务；直接使用上面的 `npm run lan:start` 即可。下面内容只作为以后需要部署到公网 VPS 时的参考。

### Ubuntu VPS + systemd + Caddy

以下路径按模板默认值编写：

```bash
sudo useradd --system --home /var/lib/team-project-manager --shell /usr/sbin/nologin teamplanner
sudo mkdir -p /opt/team-project-manager /var/lib/team-project-manager /var/backups/team-project-manager
sudo chown -R teamplanner:teamplanner /opt/team-project-manager /var/lib/team-project-manager /var/backups/team-project-manager
```

把仓库放到 `/opt/team-project-manager` 后执行：

```bash
cd /opt/team-project-manager
npm ci
npm run build
```

创建环境文件：

```bash
sudo cp deploy/team-project-manager.env.example /etc/team-project-manager.env
sudo chmod 600 /etc/team-project-manager.env
sudo nano /etc/team-project-manager.env
```

可以用下面的命令生成密钥材料：

```bash
openssl rand -base64 32
```

安装 systemd 服务和每日备份 timer：

```bash
sudo cp deploy/team-project-manager.service /etc/systemd/system/
sudo cp deploy/team-project-manager-backup.service /etc/systemd/system/
sudo cp deploy/team-project-manager-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now team-project-manager
sudo systemctl enable --now team-project-manager-backup.timer
```

Caddy 反向代理示例见 `deploy/Caddyfile.example`：

```text
your-domain.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
}
```

修改域名后加载 Caddy：

```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

发布更新：

```bash
cd /opt/team-project-manager
git pull
npm ci
npm run build
sudo systemctl restart team-project-manager
curl -fsS https://your-domain.example.com/healthz
```

查看日志：

```bash
sudo journalctl -u team-project-manager -f
```

手工备份和恢复：

```bash
sudo /opt/team-project-manager/deploy/backup-db.sh
sudo systemctl stop team-project-manager
sudo cp /var/backups/team-project-manager/app.sqlite.<时间戳> /var/lib/team-project-manager/app.sqlite
sudo chown teamplanner:teamplanner /var/lib/team-project-manager/app.sqlite
sudo systemctl start team-project-manager
```

当前仓库尚未提供 Dockerfile；当前部署方案面向单实例运行，不适合多个 Node 实例同时写同一个 `sql.js` 数据库文件。

## 应用使用说明

### 1. 注册和登录

打开应用首页后，可以选择：

- 登录已有账号。
- 注册新账号。

注册需要填写用户名、邮箱、密码和确认密码。不需要邀请码或初始化注册码。

用户名要求：

- 3 到 32 位。
- 支持小写字母、数字、点、短横线、下划线。

密码至少 6 位。

### 2. 创建项目

首次登录后，如果没有项目，会看到新建项目入口。输入项目名称后创建项目。创建者会自动成为项目成员，并拥有完整项目管理权限。

### 3. 使用知识库

进入项目后，点击顶部项目标题旁的“知识库”按钮。

知识库页面包含：

- 左侧目录：按分类展示文档，未选择分类的文档显示在“未分类”。
- 中间阅读区：显示当前文档的 Markdown 预览。
- 右侧信息区：显示文档创建者、更新时间和审批列表。

项目成员可以：

- 查看所有知识库文档。
- 新增分类。
- 重命名或删除分类。
- 新增、编辑、删除知识库文档。

### 4. 添加成员

进入团队模式后，项目成员可以在成员区域输入用户名添加成员。

成员必须先注册账号，才能通过用户名添加进项目。

项目成员还可以：

- 移除成员。

系统会阻止移除项目最后一个成员。

### 5. 创建任务

项目成员在团队模式左侧任务表单中创建任务。

任务可以选择：

- 顶层任务。
- 某个已有任务作为父任务。

因此可以形成无限层级任务树。

### 6. 创建成员分配

项目成员在分配表单中选择：

- 任务。
- 成员。
- 开始日期。
- 结束日期。
- 状态。

创建后，甘特图会显示对应成员颜色条。该分配也会同步到成员个人日程，作为全天团队事件显示。

### 7. 使用甘特图

团队甘特图顶部可以切换：

- 一周
- 一月
- 一年

可以通过日期选择器改变当前日期，也可以用上一段、今天、下一段按钮快速跳转。

项目成员还可以打开“显示个人日程”开关，把成员导入的个人日程以“忙碌”条显示在甘特图底部；关闭开关时，团队模式只显示团队任务和团队分配。

项目成员可以：

- 拖拽任务条整体移动日期。
- 拖拽任务条左边缘调整开始日期。
- 拖拽任务条右边缘调整结束日期。

所有项目成员都可以直接修改团队排期。

### 8. 添加里程碑

项目成员可以为某个任务添加里程碑：

- 选择任务。
- 选择日期。
- 输入标志文字。
- 选择颜色。

里程碑会在甘特图对应日期显示彩色标志。

### 9. 处理审批请求

项目成员可以直接修改团队排期，因此常规任务修改不再需要审批。审批区域主要用于处理“个人日程加入团队”的请求，项目成员可以批准或拒绝。

### 10. 使用个人日程

切换到个人模式后，可以使用：

- 一天视图：按小时查看和拖拽个人事件。
- 一周视图：按日期比例查看。
- 一月视图：按自然月查看。
- 一年视图：按 12 个月查看。

普通个人日程可以创建和拖拽。团队同步过来的全天事件只读。

### 11. 个人日程加入团队

在个人模式左侧“加入团队”区域：

1. 选择一个个人日程。
2. 选择“已有任务”或“新任务”。
3. 填写日期、状态和必要信息。
4. 提交审批。

项目成员批准后：

- 如果选择已有任务，会为该任务新增当前成员的分配。
- 如果选择新任务，会创建新团队任务，并为当前成员生成分配。

## 测试和检查

运行后端集成测试：

```bash
npm test
```

单独运行启动冒烟测试：

```bash
npm run test:startup
```

启动冒烟测试会检查：

- `server/index.js` 入口可以正常启动并监听随机端口。
- `/healthz` 可以公开返回健康状态。
- HTTP 服务可以返回前端入口和 SPA fallback。
- `/api` 路由在未登录时正常返回鉴权错误。
- WebSocket `/ws` 可以拒绝无效订阅，并接受项目成员订阅。
- 数据库文件路径可以创建、持久化并重新打开。
- 生产环境缺少 `AUTH_SECRET` 时拒绝启动。

运行前端构建检查：

```bash
npm run build
```

检查依赖安全审计：

```bash
npm audit --omit=dev
```

启动或部署前可以一次性运行：

```bash
npm run check
```

## 当前 v1 限制

- 未实现任务依赖线。
- 未实现自定义任务状态。
- 未实现任务拖拽排序或拖拽改变父子层级。
- 未实现浏览器系统通知或站内通知中心。
- 知识库暂不支持附件上传、全文搜索、版本历史、评论和富文本编辑器。
- 未实现复杂冲突检测；个人事件和团队事件允许并行显示。
- 未提供 Dockerfile。
- token 存储在 `localStorage`，适合 v1 原型和内网试用，正式生产需要进一步强化安全策略。
