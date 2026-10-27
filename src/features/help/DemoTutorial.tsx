import { useEffect, useMemo, useState } from "react";

import { Modal } from "../../components/Modal";

export const DEMO_TOUR_KEY = "todolist.demo-tour.v1";

interface Step {
  image: string;
  title: string;
  body: string;
  tip?: string;
}

const STEPS: Step[] = [
  {
    image: "/tutorial/01-login.png",
    title: "1. 进入系统",
    body:
      "第一次打开先创建管理员：显示名称写你在团队里想被怎么称呼（可以是中文），用户名只用来登录（字母、数字、下划线，至少 3 位）。",
    tip: "用户名里不要写中文，否则会提示“只能用字母、数字…”。中文写在显示名称里。",
  },
  {
    image: "/tutorial/03-new-project.png",
    title: "2. 建一个项目",
    body:
      "一个比赛或一个课题建一个项目，成员、排期、资料都按项目隔离。创建时可以先只选自己，之后再拉人。",
    tip: "项目名称建议用比赛名或课题名，演示时一眼能认出来。",
  },
  {
    image: "/tutorial/04-invite.png",
    title: "3. 邀请乙、丙、丁",
    body:
      "「邀请项目成员」会生成一个 6 位项目邀请码，2 小时内可以被多名已注册的同学兑换。新码会让旧码立即失效。",
    tip: "对方必须先有账号才能兑换；没有账号就先发注册邀请码（下一步）。",
  },
  {
    image: "/tutorial/05-register-invite.png",
    title: "4. 发注册邀请码",
    body:
      "新同学注册需要一次性注册邀请码：侧栏「注册邀请码」→ 生成，只显示这一次，复制发给对方，24 小时内有效。",
    tip: "码只显示一次，关掉就看不到了，记得先复制。",
  },
  {
    image: "/tutorial/06-availability.png",
    title: "5. 设置可用时间",
    body:
      "「可用时间」→ 添加学期 → 在格子里涂出你每周空闲的时段 → 填每周投入上限 → 保存。排期靠格子算时间，上限只是封顶。",
    tip: "只填上限不涂格子 = 可用时间 0 小时，任务会全部标红。页面顶部会显示“已涂 X 小时 / 每周上限 Y 小时”帮你核对。",
  },
  {
    image: "/tutorial/07-ai-settings.png",
    title: "6. 配置大模型 Key",
    body:
      "会议页「手动」→「AI 设置」→ 选平台 → 粘贴 Key → 点测试。不配 Key 也能用，但规则解析只认“谁 + 做什么 + 几小时”，文档式纪要抽不出来。",
    tip: "Key 少于 20 个字符会被直接拒绝；测试失败时红色提示会带平台返回的原因。",
  },
  {
    image: "/tutorial/08-paste-minutes.png",
    title: "7. 粘贴会议纪要",
    body:
      "会议页「粘贴会议纪要」→ 把纪要贴进去 → 开始处理。人名必须等于成员的显示名称，推荐写成：甲负责订营地，2 个小时，这周五之前。",
    tip: "人名对不上、或者完全没写工时，相关的任务会被跳过；页面会提示具体是谁。",
  },
  {
    image: "/tutorial/09-result.png",
    title: "8. 看抽取与自动修复",
    body:
      "处理完会显示抽出的任务、冲突数量和处理方案：系统会把排不下的任务拆分或调整日期，冲突降到 0。右侧「协作日志」能看到每一步。",
    tip: "出现琥珀色提示时先读一遍——那是截断、跳过成员或无 Key 的说明。",
  },
  {
    image: "/tutorial/10-gantt.png",
    title: "9. 在甘特图上确认",
    body:
      "处理完自动跳到甘特图：按周/月/年查看，点任务可改日期、工时和负责人。红色标记表示超期、容量不足、缺可用时间或依赖倒挂。",
    tip: "以后忘了怎么操作，点侧栏「使用说明」看完整文档，或点「演示教程」再看一遍这个流程。",
  },
];

export function DemoTutorial({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;

  const go = (delta: number) => setIndex((current) => Math.min(STEPS.length - 1, Math.max(0, current + delta)));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const progress = useMemo(() => `${index + 1} / ${STEPS.length}`, [index]);

  return (
    <Modal title="演示教程 · 从注册到甘特图" width="large" onClose={onClose}>
      <div className="demo-tour">
        <div className="demo-tour-stage">
          <img src={step.image} alt={step.title} loading="lazy" />
        </div>
        <div className="demo-tour-copy">
          <div className="demo-tour-progress">{progress}</div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          {step.tip !== undefined ? <p className="demo-tour-tip">⚠️ {step.tip}</p> : null}
        </div>
        <footer className="demo-tour-actions">
          <button className="secondary-button" type="button" onClick={() => setIndex(0)} disabled={index === 0}>
            回到第一步
          </button>
          <div>
            <button className="secondary-button" type="button" onClick={() => go(-1)} disabled={index === 0}>
              上一步
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => (last ? onClose() : go(1))}
            >
              {last ? "看完了" : "下一步"}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
