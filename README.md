# 多人团队项目管理应用 v1

这是一个本机可运行的多人团队项目管理应用原型，包含仪表盘、团队模式、个人模式和项目知识库。仪表盘展示项目进度、风险和成员负载，团队模式以甘特图展示多人任务排期，个人模式展示个人日程，知识库保存项目资料，并支持个人日程和知识库修改提交到团队审批。

云服务器上线步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 主要功能

- 账号系统：支持登录、邀请制注册、密码哈希存储。
- 多项目管理：用户可以创建多个项目，并在项目之间切换。
- 项目成员：管理员可以通过用户名添加成员、移除成员，并把普通成员设为管理员。
- 项目知识库：
  - 每个项目顶部都有“知识库”按钮。
  - 知识库采用分类 + 文档结构，正文使用 Markdown。
  - 所有项目成员可以查看知识库。
  - 管理员可以直接新增、编辑、删除分类和文档。
  - 普通成员可以提交新增文档或编辑文档申请，由管理员审批后生效。
- 项目仪表盘：
  - 展示任务完成率、状态分布、风险、待审批、近期里程碑和即将结束的任务。
  - 成员负载按团队任务和个人忙闲汇总计算。
  - 所有成员可看负载汇总，个人忙闲不暴露具体时间段或标题。
  - 负载容量按每日 12 小时计算，超过即标记为过载。
- 团队甘特图：
  - 支持一周、一月、一年三种量程。
  - 周从周一开始。
  - 月视图按自然月天数比例显示。
  - 年视图按 12 个自然月显示。
  - 任务条按日期比例占据时间轴宽度。
  - 管理员可打开“显示个人日程”开关，将成员个人忙闲以只读条显示在团队甘特图中；关闭后只显示团队任务。
- 无限层级任务：
  - 任务可创建任意层级父子关系。
  - 支持展开、折叠、删除。
  - 状态固定为：待办、进行中、完成。
- 成员任务分配：
  - 每个成员使用不同颜色条显示工作安排。
  - 管理员可以表单创建分配。
  - 管理员可以在甘特图中拖拽任务条移动日期，也可以拖拽左右边缘调整开始/结束日期。
- 里程碑/Deadline：
  - 每个任务可添加多个里程碑。
  - 里程碑包含日期、标题和颜色。
  - 甘特图上会在对应日期显示彩色标志。
- 审批流：
  - 普通成员不能直接修改团队排期。
  - 成员可以提交自己的任务时间/状态变更请求。
  - 成员可以把个人日程提交到团队，申请加入已有任务或创建新团队任务。
  - 管理员可以批准或拒绝请求。
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
├── index.html                # Vite 前端入口
├── package.json              # 脚本和依赖
├── vite.config.js            # Vite 配置与 /api、/ws 代理
├── server/
│   ├── index.js              # 后端启动入口
│   ├── app.js                # Express API、权限、审批、业务逻辑
│   ├── db.js                 # SQLite/sql.js 数据库初始化与持久化
│   ├── realtime.js           # WebSocket 订阅与广播
│   ├── registration.js       # bootstrap 注册码和一次性邀请码
│   ├── security.js           # 密码哈希、token 签发与校验
│   └── app.test.js           # 后端集成测试
├── src/
│   ├── main.jsx              # React 启动入口
│   ├── App.jsx               # 主应用、仪表盘、团队模式、个人模式、知识库、甘特图
│   ├── api.js                # 前端 API 与 WebSocket 客户端
│   ├── dateUtils.js          # 日期、时间轴、比例计算工具
│   └── styles.css            # 页面样式
├── scripts/
│   ├── create-invites.js     # 服务器端一次性邀请码生成脚本
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

用户通过 `/api/auth/register` 注册，通过 `/api/auth/login` 登录。注册接口需要 `registrationCode`：

- 全新数据库的第一个账号必须使用环境变量 `BOOTSTRAP_CODE`。
- 后续账号必须使用服务器命令生成的全站一次性邀请码。

后端会将密码用 `bcryptjs` 哈希后保存，并返回一个本地 token。

前端把 token 存在 `localStorage` 中。之后所有 `/api` 请求都会在请求头中带上：

```text
Authorization: Bearer <token>
```

后端在进入业务 API 前统一校验 token，并把当前用户挂载到请求对象上。

### 2. 项目和权限

每个项目都有独立成员列表。项目成员角色分为：

- `admin`：项目管理员
- `member`：普通成员

管理员可以：

- 修改项目名称。
- 添加或移除项目成员。
- 将普通成员设为管理员。
- 创建、修改、删除任务。
- 创建、修改、删除任务分配。
- 创建、删除里程碑。
- 创建、修改、删除知识库分类和文档。
- 审批成员请求。

普通成员可以：

- 查看团队项目。
- 查看自己的团队任务。
- 提交任务时间/状态变更请求。
- 管理自己的个人日程。
- 把个人日程提交给团队审批。
- 查看项目知识库，并提交新增或编辑知识库文档申请。
- 不能提交成为管理员的申请，也不能修改项目成员角色。

### 3. 数据模型

核心数据表包括：

- `users`：用户账号。
- `projects`：项目。
- `project_members`：项目成员与角色。
- `tasks`：任务，支持 `parent_id` 表达无限层级。
- `assignments`：任务分配，记录某个成员在某个任务上的开始/结束日期。
- `milestones`：任务里程碑。
- `personal_events`：个人日程，也保存由团队任务同步生成的全天事件。
- `change_requests`：审批请求。
- `knowledge_categories`：项目知识库分类。
- `knowledge_documents`：项目知识库文档，正文保存 Markdown 文本。

### 4. 项目仪表盘和负载逻辑

仪表盘是只读项目概览视图，入口位于顶部主导航。它支持两种统计范围：

- 当前周期：按当前选中日期所在的一周、一月或一年统计。
- 整个项目：按项目中最早和最晚的任务分配/里程碑日期统计；空项目 fallback 为今天。

仪表盘展示：

- 项目进度：范围内任务总数、待办、进行中、完成数量和完成率。
- 风险：逾期未完成任务分配、逾期未完成里程碑、过载成员、待审批请求。
- 成员负载：团队任务小时、个人忙闲小时、总负载小时、日均负载和过载天数。
- 近期事项：范围内里程碑、即将结束的任务分配和待审批请求。

成员负载计算规则：

- 团队任务：任务分配与统计范围重叠的每个自然日按 12 小时计入。
- 个人忙闲：普通时间事件按实际重叠小时拆分到每天；全天事件按每天 12 小时计入。
- 过载：同一成员同一天的团队任务小时加个人忙闲小时超过 12 小时。

隐私规则：

- 所有项目成员都可以看到成员负载汇总。
- 普通成员只能看到个人忙闲的每日汇总小时数，看不到事件标题、开始时间或结束时间。
- 管理员仍可以在团队模式中查看成员个人忙闲时间段，标题固定显示为“忙碌”。

### 5. 团队甘特图逻辑

团队模式的时间轴由前端根据当前选中日期和量程计算：

- 周视图：显示当前日期所在自然周，周一到周日。
- 月视图：显示当前日期所在自然月，按真实天数显示。
- 年视图：显示当前日期所在自然年，按 12 个自然月显示。

任务分配条根据 `startDate`、`endDate` 和当前可见时间段计算百分比位置：

- `left` 表示距离当前时间段开始的比例。
- `width` 表示任务持续天数占当前时间段的比例。

管理员拖拽任务条时，前端按当前视图宽度换算成天数偏移，再调用后端更新 `assignments`。

### 6. 个人日程逻辑

个人模式支持日、周、月、年：

- 日视图显示 24 小时网格。
- 普通个人事件可以拖拽。
- 拖拽时按 5 分钟吸附。
- 团队同步事件为只读全天事件。

当管理员给成员创建团队任务分配时，后端会自动在该成员的个人日程中生成一条团队全天事件。更新或删除分配时，对应的个人团队事件也会同步更新或删除。

### 7. 知识库逻辑

知识库是项目级资料区，入口位于顶部项目标题旁的“知识库”按钮。进入后：

- 左侧显示分类和文档列表。
- 中间显示当前文档的 Markdown 预览。
- 右侧显示文档信息和审批列表。

知识库权限：

- 项目成员都可以读取当前项目知识库。
- 管理员可以直接新增、重命名、删除分类。
- 管理员可以直接新增、编辑、删除文档。
- 普通成员不能直接写入知识库，只能提交新增或编辑文档申请。

分类删除后，该分类下的文档不会被删除，会自动转为“未分类”。

Markdown 预览由前端按安全文本渲染，不执行文档中的 HTML。

### 8. 审批逻辑

普通成员提交的请求会进入 `change_requests` 表。当前支持五类请求：

- `assignment_update`：申请修改自己的团队任务时间或状态。
- `personal_to_team_assignment`：申请把个人日程加入已有团队任务。
- `personal_to_team_task`：申请把个人日程变成新的团队任务。
- `knowledge_document_create`：申请新增知识库文档。
- `knowledge_document_update`：申请编辑已有知识库文档。

管理员批准请求后，后端会执行对应写入：

- 修改已有任务分配。
- 新增任务分配。
- 新建任务并新增任务分配。
- 新增知识库文档。
- 更新知识库文档。

管理员拒绝请求时，只更新请求状态，不改变任务数据。

### 9. 实时同步逻辑

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
BOOTSTRAP_CODE=demo-bootstrap npm run dev
```

如果本地库里已经有账号，也可以直接运行：

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

空库首次生成演示数据时，先在应用未启动时准备 3 个一次性邀请码：

```bash
npm run invite:create -- --count 3
```

记录命令输出的 3 个邀请码。然后用 `BOOTSTRAP_CODE=demo-bootstrap npm run dev` 启动应用，在另一个终端执行：

```bash
BOOTSTRAP_CODE=demo-bootstrap DEMO_REGISTRATION_CODES=code1,code2,code3 npm run seed:demo
```

如果演示账号已经存在，直接在应用运行时执行 `npm run seed:demo` 即可，脚本会登录已有账号继续创建新的演示项目。

脚本会创建一组演示账号、项目、任务树、成员排期、里程碑、知识库文档、个人日程和待审批请求。

演示账号：

```text
demo_admin / demo123456
demo_alice / demo123456
demo_bob / demo123456
demo_chen / demo123456
```

推荐先用 `demo_admin` 登录查看团队模式，再用另一个浏览器或隐私窗口登录 `demo_bob` 检查多人同步和个人模式。

## 构建和生产启动

运行要求：Node.js `>=22.12`，推荐 Node.js 24 LTS。

### 1. 构建前端

```bash
npm ci
npm run build
```

构建产物会输出到：

```text
dist/
```

### 2. 启动生产服务

```bash
NODE_ENV=production \
HOST=127.0.0.1 \
PORT=4000 \
DB_PATH=/var/lib/team-project-manager/app.sqlite \
AUTH_SECRET=<随机强密钥> \
BOOTSTRAP_CODE=<首个管理员注册码> \
npm start
```

生产启动后，后端会：

- 提供 `/api` 接口。
- 提供 `/ws` WebSocket 服务。
- 静态托管 `dist/` 中的前端文件。
- 提供公开健康检查 `/healthz`。

生产环境缺少 `AUTH_SECRET` 或 `BOOTSTRAP_CODE` 时会拒绝启动。默认建议只监听本机：

```text
http://127.0.0.1:4000/
```

### 3. 环境变量

常用环境变量：

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
DB_PATH=/var/lib/team-project-manager/app.sqlite
AUTH_SECRET=replace-with-a-random-secret
BOOTSTRAP_CODE=replace-with-first-admin-registration-code
APP_URL=http://localhost:4000
```

说明：

- `NODE_ENV`：设为 `production` 时启用生产启动检查。
- `HOST`：监听地址；生产建议 `127.0.0.1`，由反向代理对公网提供 HTTPS。
- `PORT`：后端服务端口。
- `DB_PATH`：数据库文件路径；生产默认建议 `/var/lib/team-project-manager/app.sqlite`。
- `AUTH_SECRET`：token 签名密钥，生产环境必须设置为随机强密钥。
- `BOOTSTRAP_CODE`：全新数据库第一个账号使用的一次性初始化注册码。
- `APP_URL`：演示数据脚本访问的后端地址。

### 4. 数据持久化

开发默认数据库文件：

```text
data/app.sqlite
```

生产数据库建议放在：

```text
/var/lib/team-project-manager/app.sqlite
```

数据库写入会先写同目录临时文件再原子替换目标文件。部署时需要保证数据库目录可写，并把该目录纳入备份策略。

### 5. 生成邀请码

全新生产库先用 `BOOTSTRAP_CODE` 注册第一个管理员。之后在服务器上生成一次性邀请码：

```bash
cd /opt/team-project-manager
sudo -u teamplanner env DB_PATH=/var/lib/team-project-manager/app.sqlite npm run invite:create -- --count 3
```

命令只会打印一次明文邀请码，数据库中只保存哈希。每个邀请码永久有效，但只能成功注册一次。

## 部署建议

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
- 使用注册码注册新账号。

全新生产库的第一个账号使用 `/etc/team-project-manager.env` 中的 `BOOTSTRAP_CODE` 注册。第一个账号登录后可以创建第一个项目。后续成员注册前，服务器管理员先执行：

```bash
cd /opt/team-project-manager
sudo -u teamplanner env DB_PATH=/var/lib/team-project-manager/app.sqlite npm run invite:create -- --count 1
```

然后把输出的邀请码发给对应成员。每个邀请码只能成功使用一次。

用户名要求：

- 3 到 32 位。
- 支持小写字母、数字、点、短横线、下划线。

密码至少 6 位。

### 2. 创建项目

首次登录后，如果没有项目，会看到新建项目入口。输入项目名称后创建项目。创建者会自动成为项目管理员。

### 3. 使用仪表盘

创建或进入项目后，顶部主导航默认可以进入“仪表盘”。

仪表盘顶部可以切换：

- 当前周期：按当前日期所在的一周、一月或一年统计。
- 整个项目：按项目所有任务分配和里程碑的日期范围统计。

仪表盘中可以检查：

- 项目进度：任务完成率和待办/进行中/完成数量。
- 风险：逾期任务、逾期里程碑、过载成员和待审批数量。
- 成员负载：每个成员的团队任务小时、个人忙闲汇总小时、总负载、日均负载和过载天数。
- 近期事项：当前范围内的里程碑、即将结束的任务和待审批请求。

负载容量按每天 12 小时计算。个人忙闲只以汇总小时参与负载，普通成员看不到其他人的个人日程标题或具体时间段。

### 4. 使用知识库

进入项目后，点击顶部项目标题旁的“知识库”按钮。

知识库页面包含：

- 左侧目录：按分类展示文档，未选择分类的文档显示在“未分类”。
- 中间阅读区：显示当前文档的 Markdown 预览。
- 右侧信息区：显示文档创建者、更新时间和审批列表。

管理员可以：

- 新增分类。
- 重命名或删除分类。
- 新增、编辑、删除知识库文档。

普通成员可以：

- 查看所有知识库文档。
- 点击“申请新增”提交新文档申请。
- 选中文档后点击“申请编辑”提交修改申请。

管理员批准知识库申请后，文档会立即创建或更新；拒绝申请不会修改知识库。

### 5. 添加成员

进入团队模式后，管理员可以在左侧成员区域输入用户名添加成员。

成员必须先注册账号，管理员才能通过用户名添加。

管理员还可以：

- 把成员设为管理员。
- 移除成员。

系统会阻止移除最后一个管理员。普通成员没有申请成为管理员的入口。

### 6. 创建任务

管理员在团队模式左侧任务表单中创建任务。

任务可以选择：

- 顶层任务。
- 某个已有任务作为父任务。

因此可以形成无限层级任务树。

### 7. 创建成员分配

管理员在分配表单中选择：

- 任务。
- 成员。
- 开始日期。
- 结束日期。
- 状态。

创建后，甘特图会显示对应成员颜色条。该分配也会同步到成员个人日程，作为全天团队事件显示。

### 8. 使用甘特图

团队甘特图顶部可以切换：

- 一周
- 一月
- 一年

可以通过日期选择器改变当前日期，也可以用上一段、今天、下一段按钮快速跳转。

管理员还可以打开“显示个人日程”开关，把成员导入的个人日程以“忙碌”条显示在甘特图底部；关闭开关时，团队模式只显示团队任务和团队分配。

管理员可以：

- 拖拽任务条整体移动日期。
- 拖拽任务条左边缘调整开始日期。
- 拖拽任务条右边缘调整结束日期。

普通成员只能查看，不能直接修改团队排期。

### 9. 添加里程碑

管理员可以为某个任务添加里程碑：

- 选择任务。
- 选择日期。
- 输入标志文字。
- 选择颜色。

里程碑会在甘特图对应日期显示彩色标志。

### 10. 成员提交变更请求

普通成员在团队模式左侧可以提交自己的任务变更请求：

- 选择自己的任务分配。
- 修改开始日期、结束日期、状态。
- 提交审批。

管理员会在审批区域看到待处理请求，可以批准或拒绝。

### 11. 使用个人日程

切换到个人模式后，可以使用：

- 一天视图：按小时查看和拖拽个人事件。
- 一周视图：按日期比例查看。
- 一月视图：按自然月查看。
- 一年视图：按 12 个月查看。

普通个人日程可以创建和拖拽。团队同步过来的全天事件只读。

### 12. 个人日程加入团队

在个人模式左侧“加入团队”区域：

1. 选择一个个人日程。
2. 选择“已有任务”或“新任务”。
3. 填写日期、状态和必要信息。
4. 提交审批。

管理员批准后：

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
- 生产环境缺少 `AUTH_SECRET` 或 `BOOTSTRAP_CODE` 时拒绝启动。
- 邀请码脚本可以写入 `DB_PATH` 指向的数据库。

运行生产构建检查：

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
