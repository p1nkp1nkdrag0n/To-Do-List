/**
 * 抽取员的规则解析层单测（不依赖任何密钥、不联网）。
 *
 * 大模型那条路需要外部 API，不放单元测试里；这里锁住的是「没有 key 时的兜底行为」。
 */
import { describe, expect, it } from "vitest";

import { extractWithRules } from "../../../server/meeting/extractor.js";

const MEMBERS = ["张工", "李工", "邱业恒"];

describe("会议纪要规则解析", () => {
  it("认「说话人：任务 + N 个钟头」并归到正确的负责人", () => {
    const tasks = extractWithRules(
      "张工：MCP 工具层接口联调我来接，大概十个钟头，这周五之前。",
      MEMBERS,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ ownerName: "张工", estimatedHours: 10 });
    expect(tasks[0]!.title).toContain("MCP");
  });

  it("句子里提到别人的名字时，仍按说话人前缀归属", () => {
    const tasks = extractWithRules(
      "李工：甘特图和冲突面板我来调，八个钟头，等张工接口好了我才能开始。",
      MEMBERS,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.ownerName).toBe("李工");
    expect(tasks[0]!.estimatedHours).toBe(8);
  });

  it("认「甲负责某事 + 工时」这种没有冒号的写法", () => {
    const tasks = extractWithRules("甲负责订营地，2 个小时。", ["甲", "乙"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ ownerName: "甲", estimatedHours: 2 });
    expect(tasks[0]!.title).toBe("订营地");
  });

  it("认「某事由甲负责」这种被动写法", () => {
    const tasks = extractWithRules("订营地由甲负责，2 个小时。", ["甲", "乙"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("订营地");
  });

  it("支持阿拉伯数字工时", () => {
    const tasks = extractWithRules("邱业恒：写脚本，4 小时，这周末前。", MEMBERS);
    expect(tasks[0]!.estimatedHours).toBe(4);
  });

  it("没有工时的句子不抽（宁可少抽也不乱抽）", () => {
    expect(extractWithRules("邱业恒：大家辛苦了。", MEMBERS)).toHaveLength(0);
  });

  it("负责人不在成员名单里就不抽", () => {
    expect(extractWithRules("王五：做个页面，三个小时。", MEMBERS)).toHaveLength(0);
  });

  it("一段完整纪要能抽出多条，且标题不带「我来接」这类尾巴", () => {
    const tasks = extractWithRules(
      [
        "张工：MCP 工具层接口联调我来接，大概十个钟头。",
        "李工：甘特图和冲突面板我来调，八个钟头。",
        "邱业恒：会议录音脚本和话术我来写，四个钟头。",
      ].join("\n"),
      MEMBERS,
    );
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.title).not.toContain("我来");
    }
  });

  it("负责人被听错、不在名单时，任务保留为未分配", () => {
    const tasks = extractWithRules("玖魇桁负责整理演示稿需要2小时。", MEMBERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ ownerName: "未分配", estimatedHours: 2 });
    expect(tasks[0]!.title).toBe("整理演示稿");
  });

  it.each([
    ["甲负责实现24小时制显示，2小时", "实现24小时制显示"],
    ["甲负责实现24小时制显示需要2小时", "实现24小时制显示"],
    ["甲负责建设24小时监控需要2小时", "建设24小时监控"],
    ["甲负责实现H5页面需要2h", "实现H5页面"],
  ])("保留标题内非工时数字：%s", (text, title) => {
    expect(extractWithRules(text, ["甲"])).toMatchObject([{ title, ownerName: "甲", estimatedHours: 2 }]);
  });

  it("24小时制不是工时，不能单独据此抽取任务", () => {
    expect(extractWithRules("甲负责实现24小时制显示", ["甲"])).toEqual([]);
  });

  it("未知负责人仍保留未分配与完整数字标题", () => {
    expect(extractWithRules("玖魇桁负责实现24小时制显示需要2小时", MEMBERS))
      .toMatchObject([{ title: "实现24小时制显示", ownerName: "未分配", estimatedHours: 2 }]);
  });

  it("支持明确的小数工时而不丢弃任务", () => {
    expect(extractWithRules("甲负责实现24小时制显示需要1.5小时", ["甲"]))
      .toMatchObject([{ title: "实现24小时制显示", estimatedHours: 1.5 }]);
  });

  it.each(["-2小时", "0小时", "201小时", "2小时后交付", "24h格式", "2小时，4小时", "2小时或4小时"])(
    "不将无效或不明确的时长当工时：%s", estimate => {
      expect(extractWithRules(`甲负责实现界面，${estimate}`, ["甲"])).toEqual([]);
    },
  );

});
