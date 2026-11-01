# 交付说明（会议 → 排期流水线）

> 这份文档同时用于 PR 描述。对应 fork：`qyhsktn/To-Do-List`，分支 `main`，基线 `upstream/main`。

## 一、这次交付了什么

在原「TO DO LIST v2」之上，新增一条从会议到排期的链路，**没有改动原有排期引擎**：

```
会议纪要（粘贴 / txt / docx / pdf）
        ↓  抽取员（大模型）
    结构化任务（谁、做什么、几小时、截止、依赖）
        ↓  排期员（MCP 工具）
    建任务 / 派人 / 建依赖 → 冲突计算
        ↓  协调员
    试算方案 → 自动应用 → 甘特图
```

| 模块 | 文件 | 说明 |
|---|---|---|
| MCP Server | `server/mcp/*` | 10 个工具：`list_projects`、`get_tasks`、`list_members`、`get_availability`、`check_conflicts`、`create_task`、`assign_member`、`set_dependency`、`plan_reschedule`、`apply_plan` |
| 重排算法 | `server/mcp/reschedule.ts` | 贪心 + 有界束搜索；评分按 冲突 → 缺口 → 延期 → 动作数；支持「负责人锁定」 |
| 编排器 | `server/meeting/orchestrator.ts` | 拉起 MCP 子进程，按序调用工具，广播事件 |
| 抽取 | `server/meeting/extractor.ts` | 大模型优先，规则兜底（「谁 + 做什么 + 几小时」） |
| 文件解析 | `server/meeting/minutes-file.ts` | txt / md / docx（mammoth）/ pdf（pdf-parse） |
| 前端 | `src/features/meeting/*` | 会议页：转写/纪要、协作日志、冲突明细、方案对比、暂停、撤销、AI 设置 |
| 演示数据 | `scripts/seed-demo-v3.ts`、`scripts/setup-camp-team.ts` 等 | 可复现的空白/生活化开局 |

**能力清单**

- 纪要 → 任务：大模型抽取，负责人、工时、截止日、依赖
- 冲突检测：工时排不下 / 依赖倒挂 / 逾期 / 缺可用时间
- 自动重排：换人、拆分工、延期、整体平移，返回最多 3 个方案并标出推荐
- 撤销：一键回滚上一次自动调整（落盘，重启仍可撤销）
- 负责人锁定：只允许延期/平移，不换人不拆分
- 实时：WebSocket 广播处理事件，页面无需刷新
- 多用户：账号体系 + 项目成员隔离；大模型 Key **按用户存储**，互不共用
- 演示控制：暂停/继续、清空排期、演示节奏（每步停 1.2 秒）

## 二、怎么跑

```powershell
npm install
npm run demo          # API(4000) + 前端(5173)
npm run demo:reset    # 清空所有项目排期（成员与可用时间保留）
```

浏览器打开 `http://localhost:5173`。

**演示步骤（约 1 分钟）**

1. 用部署者账号登录，进入项目 **Demo**
2. 「会议」→「粘贴会议纪要」→「填入示例纪要」（周末露营筹备，甲乙丙丁）
3. 开始处理：4 条任务 → 发现 1 条冲突 → 自动修复 → 6 秒后跳甘特图

**模型配置**：「手动」→「AI 设置」→ 添加供应商（DeepSeek / 硅基流动 / 通义 / 智谱 / Kimi / 自定义），
填自己的 Key；每个账号独立，环境变量只作为部署者的可选兜底（`LLM_ALLOW_SHARED_FALLBACK=1`）。

## 三、部署状态：**还没有部署，需要学长决定**

| 项 | 现状 |
|---|---|
| 运行环境 | 目前只在开发机本地跑（Windows + Node 24） |
| 生产构建 | ✅ 已验证：`npm run build` + `npm start` 可正常提供页面与接口 |
| 数据库 | SQLite 单文件 `data/v2/app.sqlite`；**一次只能跑一个 API 进程** |
| HTTPS / 反向代理 | 未做；README 里有 Caddy 示例，需要真实域名/server |
| 演示账号 | 种子脚本创建的账号密码是 `demo1234`，**公网部署前必须换库或改密** |
| 是否公开给多人用 | **待定**：需要一台服务器（实验室/云服务器）与维护人 |

> 如果学长希望部署，我可以补：Dockerfile、Nginx/Caddy 配置、换库脚本、初始化流程（bootstrap code）。

## 四、issue #3（依赖审计）完成情况

| issue 里的要求 | 状态 | 说明 |
|---|---|---|
| 核实运行时依赖与构建工具边界 | ✅ | 见 `docs/dependency-audit.md`：express/zod 为运行时；vite/postcss/nanoid 为构建期 |
| 确认兼容修复版本与升级路径，避免 `npm audit fix --force` | ✅ | 同大版本补丁升级，未用 `--force` |
| 更新依赖后复跑类型检查 / 构建 / v2 测试 / E2E | ⚠️ 部分 | 类型 0 错误、368/372 单测、构建通过；**E2E 未复跑**（本机 `playwright install chromium` 被系统权限拦住） |
| 复核第三方许可产物 | ✅ | `npm run build` 生成 `dist/legal/*`，许可检查通过 |
| 保存新审计结果，逐项记录影响判断 | ✅ | `docs/dependency-audit.md` |

**审计结果**：`npm audit` 与 `npm audit --omit=dev` 均为 **0 漏洞**（此前 3 critical / 5 high / 2 moderate）。
另外移除了 `concurrently`（换成 `scripts/dev-run.mjs`），去掉了 `shell-quote` 命令注入链。

## 五、已知限制（不隐藏）

| 限制 | 影响 | 计划 |
|---|---|---|
| 录音上传已关闭 | 只能走纪要/文件，不接 ASR | 拿到思必驰等 ASR 后接一个 provider；入口保留 |
| Playwright E2E 未在本次环境复跑 | 不能宣称全绿 | 在可安装浏览器的机器上补跑 |
| 抽取一次最多 12 条任务、纪要 2 万字 | 超长会议要拆分 | 可按需调大上限 |
| 纪要里没写负责人时 | 任务会建成「未分配」，不产生冲突 | 甘特图里指派后重新处理 |
| 多人共用同一台服务器 | 各自配 Key，管理员可开共享兜底 | 部署时决定 |

## 六、本次 PR 的范围

- 46+ 个提交：会议页、MCP 工具、重排算法、抽取、撤销、暂停、AI 供应商、多用户 Key 隔离、演示数据、安全加固
- 已合并 upstream 的 AGPL-3.0 许可与合规脚本（无冲突）
- 依赖升级至修复版本（审计清零）
- 文档：`docs/dependency-audit.md`、`docs/delivery.md`

**没有改动**：原有排期引擎、权限模型、备份恢复、许可与合规逻辑。
