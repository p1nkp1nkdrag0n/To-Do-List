# TO DO LIST v2

面向小型科研、课程和比赛团队的项目协作工具。以甘特图组织任务、成员投入和截止时间，将会议纪要转成排期，并把资料版本、进展和验收记录留在同一个项目里。

支持从源码运行，也提供 Windows 便携目录与单文件 EXE 的构建脚本。一个部署实例服务一个团队，团队成员通过浏览器访问。

[快速启动](#快速启动) · [会议到排期](#会议到排期) · [开发与验证](#开发与验证) · [部署与备份](docs/deployment-guide.md) · [文档索引](#文档索引) · [开源许可](#开源许可与对应源码)

## 核心功能

- **项目排期**：甘特图、阶段、子任务、成员分工、依赖、里程碑、周期任务和模板。
- **容量与冲突**：结合成员可用时间和预计工时，检查容量不足、依赖倒挂和逾期，并提供重排方案。
- **会议辅助**：粘贴纪要、导入文本/Word/PDF、上传录音或实时转写，抽取负责人、任务、工时与依赖。
- **确认与撤销**：实时会议先确认任务清单；依赖绑定稳定任务 ID。批量创建、计划应用和撤销带有事务与版本保护。
- **团队协作**：注册与项目邀请、在线状态、拖拽锁、进展记录和任务验收。
- **资料管理**：Markdown 与文件上传、版本记录、归档、回收站和离线备份。

## 快速启动

需要 **Node.js 24 或更新版本**、npm 和 Git。在终端执行：

```shell
git clone https://github.com/p1nkp1nkdrag0n/To-Do-List.git
cd To-Do-List
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。API 默认在 `4000` 端口；以终端实际输出为准。

1. 全新数据库会进入首个账号创建页面。填写用户名、显示名称和密码；本地开发的默认初始化码是 `development-bootstrap-code`。
2. 创建项目，添加成员，并在「可用时间」中填写各自能投入的时间。
3. 通过侧栏「注册邀请码」邀请新成员注册，再通过项目邀请码让已有账号加入项目。两种邀请码用途不同。
4. 在甘特图中安排任务，或进入「会议」从纪要生成排期。

未另行配置时，数据库在 `data/v2/app.sqlite`，上传文件在 `data/v2/uploads`。服务入口会读取工作目录的 `.env`，已设置的进程环境变量优先。开发默认密钥仅供本地试用；团队部署请按[部署指南](docs/deployment-guide.md)配置。

`npm run demo` 也会启动前后端服务，但 API 不热重载，且不会自动创建演示账号或项目。演示种子、`demo:reset` 等脚本会写入或清空数据，只应用于独立测试实例。

## 会议到排期

### 输入与配置

在项目「会议」页面粘贴纪要或导入 `.txt`、`.md`、`.docx`、`.pdf` 文件。通过「手动 → AI 设置」配置自己的模型供应商和 Key；未配置或模型调用失败时，会尝试规则解析，适合“成员负责某任务，预计几小时”这类明确表述。

录音上传和实时记录需要配置语音转写服务。当前接入思必驰，文件转写与实时转写可能使用不同的产品配置。手工排期和文本纪要入口不要求先配置语音服务。

### 处理流程

1. **文本纪要**：检查负责人锁定和「先清空本项目排期」选项，再点击「开始处理」。该入口会直接抽取并提交任务。
2. **实时会议**：结束记录后进入确认清单，可调整标题、负责人、工时与前驱；同名或缺失前驱需要明确确认，随后才生成排期。
3. **排期结果**：系统创建任务、计算冲突并尝试重排。查看处理日志和剩余冲突，必要时回到甘特图调整。
4. **撤销调整**：可以撤销上一次自动调整；相关记录已被人工修改时会拒绝覆盖。撤销自动调整不等于恢复被替换的整份旧排期。

「先清空本项目排期」默认勾选；需要追加任务时先取消。未分配负责人的任务需要后续指派，才能纳入成员容量计算。冲突计算以当前项目为范围。

模型和语音配置按用户保存。服务器模型 Key 只有显式启用 `LLM_ALLOW_SHARED_FALLBACK=1` 才可作为共享兜底；这会使用部署者的服务额度。

## 开发与验证

技术栈：React 19、TypeScript、Vite 8、Express、WebSocket、Node.js 内置 SQLite、Zod；测试使用 Vitest、Supertest 和 Playwright。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动前后端开发服务 |
| `npm run typecheck` | 检查前后端及测试 TypeScript |
| `npm run build` | 构建客户端、服务端，并检查许可与对应源码产物 |
| `npm start` | 启动构建后的服务；生产模式需另设环境变量 |
| `npm test` | 运行 v2 单元与集成测试 |
| `npm run test:e2e` | 运行团队工作流、会议确认和许可页面等浏览器回归 |
| `npm run test:packaging` | 运行数据目录、迁移及启动器回归 |
| `npm run test:legacy` | 运行保留的 v1 回归 |
| `npm run check` | 依次运行类型检查、构建、v2 测试、打包测试、E2E 和生产依赖审计 |

E2E 默认使用 Playwright Chromium，首次可执行 `npx playwright install chromium`。Windows 已安装 Edge 时，也可在 PowerShell 中先设置 `$env:PLAYWRIGHT_CHANNEL = "msedge"`。测试会使用 `4000`、`5173` 端口和仓库下可重建的 `.e2e-runtime` 目录，运行前应停止占用这些端口的开发服务。

打包测试中的 C# 原生场景仅在 Windows 执行，要求 .NET Framework C# 编译器；其他平台会明确跳过。最近一次完整验证及其环境边界见 [PR #6](https://github.com/p1nkp1nkdrag0n/To-Do-List/pull/6)。真实麦克风、外部 ASR/模型、真机和完整 EXE 首启/升级需单独验收。

```text
src/                    React 页面、功能模块和样式
server/modules/         鉴权、项目、排期、可用时间、资料与备份
server/meeting/         会议编排、抽取、转写、配置与撤销
server/mcp/             MCP 工具和重排算法
server/db/              SQLite 适配与迁移
server/realtime/        WebSocket 协作
server/cli/             注册邀请、离线备份与恢复
shared/                 前后端共享契约
packaging/              便携启动器和 Windows 单文件打包
tests/                  单元、集成、浏览器和打包测试
deploy/                 生产环境与反向代理示例
```

## 文档索引

| 需要做什么 | 文档 |
| --- | --- |
| 部署团队服务、配置 HTTPS、备份恢复、构建 Windows 程序 | [部署与数据维护](docs/deployment-guide.md) |
| 手工走一遍安装与会议流程 | [验证清单](docs/验证清单.md) |
| 理解启动器的文件系统保护和验收边界 | [解压安全说明](docs/launcher-extraction-safety.md) |
| 查阅第三方依赖声明 | [第三方许可](THIRD_PARTY_NOTICES.md) |
| 查看界面示例 | [实时工作区](docs/images/realtime-workspace.png) · [确认清单](docs/images/task-confirmation.png) · [资料库](docs/images/resource-library.png) |

以下资料保留开发过程和当时结论，按各自日期、提交与环境阅读：

- [早期会议功能交付说明](docs/delivery.md)、[桌面版设计与阶段记录](docs/desktop-packaging.md)。
- [历史问题与修复记录](docs/PRODUCTION_BACKLOG.md)、[依赖审计记录](docs/dependency-audit.md)、[2026-10-31 内部验证记录](release-notes.md)。
- 技术报告：[Word](docs/会议排期系统技术报告.docx) · [PDF](docs/会议排期系统技术报告.pdf)。

历史材料中的 EXE 名称和体积不代表当前可下载的版本。正式分发应在 [Releases](https://github.com/p1nkp1nkdrag0n/To-Do-List/releases) 提供实际附件、完整源码提交 SHA 和文件 SHA-256。

## 项目维护与贡献

本仓库由 [p1nkp1nkdrag0n](https://github.com/p1nkp1nkdrag0n) 维护。会议排期、语音与桌面启动器等功能包含 [qyhsktn](https://github.com/qyhsktn/meeting-scheduler) 的开发贡献；这些工作与后续修复通过 [PR #6](https://github.com/p1nkp1nkdrag0n/To-Do-List/pull/6) 整合，原始提交历史保留在仓库中。

也感谢 GPT-5.5、GPT-6 Astra、DeepSeek V4.1 Flash 1017 和 Kimi K3.1 在项目开发中的参与和帮助。

当前默认运行 v2；v1 代码仅为历史兼容与回归保留。v2 不读取或迁移 v1 业务数据库。桌面启动器的“旧数据迁移”指旧版 v2 的存储目录迁移，详见[部署指南](docs/deployment-guide.md)。

## 开源许可与对应源码

项目原创代码采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，不含“或任何更新版本”授权。许可全文见 [LICENSE](LICENSE)，本软件不提供任何担保。第三方依赖、字体和图标保留各自许可及作者声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与[完整声明](licenses/npm-notices.txt)。

应用的「关于 / 开源许可」入口打开 `/legal/`，无需登录即可阅读许可并下载**当前构建对应的源码包**。构建按文件清单和 SHA-256 标识源码，不使用可变的 `main` 链接。新增源码须先审阅并 `git add`；分发时保留同次构建的 `dist/legal/`、客户端和服务端产物。依赖变更后运行 `npm run licenses:update` 并审阅声明，发布前运行 `npm run licenses:check`。

下载的对应源码包可独立构建：解压后进入 `to-do-list/`，执行 `npm ci`、`npm run build`；包内 `SOURCE_MANIFEST.json` 供无 Git 环境使用。从该包继续开发并新增文件时，先初始化 Git、删除旧清单并审阅跟踪源码。源码包排除真实密钥、数据库、上传文件和备份；更多部署说明随包保存在 `docs/deployment-guide.md`。
