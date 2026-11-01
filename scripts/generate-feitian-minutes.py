"""生成「飞天探微」第三轮会议纪要的多个版本（docx / txt / html）。

用法：
  python scripts/generate-feitian-minutes.py
输出到 samples/feitian-minutes/
"""
from pathlib import Path

from docx import Document
from docx.shared import Pt

OUT = Path(__file__).resolve().parent.parent / "samples" / "feitian-minutes"
OUT.mkdir(parents=True, exist_ok=True)

FORMAL_TITLE = "飞天探微项目第三次例会纪要"
META = [
    ("会议时间", "2026 年 10 月 22 日 19:00–20:30"),
    ("会议地点", "航天学院 312 会议室（线下）+ 腾讯会议"),
    ("参会人员", "邱业恒、柴子笑、刘伊昕、汪筱莜、徐彪、学长"),
    ("记录人", "柴子笑"),
]

FORMAL_BODY = [
    ("一、会议目标", [
        "确认第二次会议遗留问题，明确本轮各模块交付物与时间节点。",
        "统一申报书与答辩 PPT 的口径，避免各模块自说自话。",
    ]),
    ("二、仿真模块", [
        "邱业恒汇报：着陆腿碰撞力仿真已完成建模，机械腿应力集中分析还差工况收敛。",
        "本轮要求：输出两大场景的可视化结果（着陆腿碰撞力承载、机械腿应力集中点风险），并补齐材质赋值与重量核算。",
        "邱业恒负责，预计投入 10 小时，10 月 29 日前给出第一版结果。",
    ]),
    ("三、轨道模块", [
        "刘伊昕说明：椭圆轨道基础设计已完成，小行星带遍历周期与交汇对接窗口还在算。",
        "本轮要求：完成遍历周期与对接窗口的数值计算，整理成一张表。",
        "刘伊昕负责，预计 6 小时，11 月 5 日前交付。",
        "注意：刘伊昕 11 月 3 日至 11 月 5 日在外出差，这三天不要给她排活。",
    ]),
    ("四、文档与汇报", [
        "柴子笑负责申报书第三版统稿，预计 8 小时，11 月 10 日前完成。",
        "答辩 PPT 定 15 页，由柴子笑负责，预计 6 小时，11 月 12 日前完成。",
        "PPT 要等仿真和光学的图，所以排在仿真结果出来之后。",
    ]),
    ("五、其他分工", [
        "汪筱莜负责仿真软件学习，并写一份上手指引，预计 6 小时，11 月 8 日前。",
        "汪筱莜同时补充光学模块的关键参数，预计 4 小时，11 月 6 日前；这一项要等邱业恒的仿真结果。",
        "徐彪负责更新项目进度表（Excel），预计 3 小时，本周日之前。",
    ]),
    ("六、风险与决议", [
        "风险一：仿真与文档高度依赖邱业恒，他这周可用时间只有 8 小时，可能排不开。",
        "风险二：刘伊昕出差三天，轨道计算窗口很窄。",
        "决议：负责人不变，允许通过延期解决排期冲突；不得把任务转给别人。",
    ]),
]

NOTES_LINES = [
    ("邱业恒", "这周我主要推进真，着陆腿碰撞那块建模完了，机械腿应力还在收。"),
    ("邱业恒", "仿真这块我大概还要十个钟头，月底前能给第一版。"),
    ("刘伊昕", "轨道基础设计做完了，遍历周期和对接窗口还在算，六个钟头差不多。"),
    ("刘伊昕", "不过我 11 月 3 号到 5 号要出差，这几天别给我排。"),
    ("柴子笑", "申报书第三版我来统，八个钟头，11 月 10 号前。"),
    ("柴子笑", "答辩 PPT 十五页，六个钟头，等仿真和光学的图出来我再做，11 月 12 号前。"),
    ("汪筱莜", "我先把软件摸熟，写个上手指引，六个钟头，11 月 8 号前。"),
    ("汪筱莜", "光学参数那块我补，四个钟头，11 月 6 号前，但要等邱业恒仿真结果。"),
    ("徐彪", "进度表我更新一下，三个钟头，这周日之前给。"),
    ("学长", "负责人别乱换，人定了就是定了，排不开就用时间换。"),
]

TASK_ROWS = [
    ("仿真结果第一版（碰撞力 + 应力）", "邱业恒", "10", "10-29"),
    ("小行星带遍历周期与对接窗口计算", "刘伊昕", "6", "11-05"),
    ("申报书第三版统稿", "柴子笑", "8", "11-10"),
    ("答辩 PPT 15 页", "柴子笑", "6", "11-12"),
    ("仿真软件上手指引", "汪筱莜", "6", "11-08"),
    ("光学模块参数补充", "汪筱莜", "4", "11-06"),
    ("项目进度表更新", "徐彪", "3", "10-25"),
]


def write_docx(path: Path, title: str, body, with_table: bool = False) -> None:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "宋体"
    normal.font.size = Pt(10.5)
    doc.add_heading(title, level=1)
    for key, value in META:
        doc.add_paragraph(f"{key}：{value}")
    doc.add_paragraph("")
    for heading, bullets in body:
        doc.add_heading(heading, level=2)
        for line in bullets:
            doc.add_paragraph(line, style="List Bullet")
    if with_table:
        doc.add_heading("附：任务清单", level=2)
        table = doc.add_table(rows=1, cols=4)
        table.style = "Table Grid"
        header = table.rows[0].cells
        for i, text in enumerate(["任务", "负责人", "工时(h)", "截止"]):
            header[i].text = text
        for row in TASK_ROWS:
            cells = table.add_row().cells
            for i, text in enumerate(row):
                cells[i].text = text
    doc.save(path)


def formal_text() -> str:
    lines = [FORMAL_TITLE, ""]
    lines += [f"{k}：{v}" for k, v in META]
    lines.append("")
    for heading, bullets in FORMAL_BODY:
        lines.append(heading)
        lines += [f"- {b}" for b in bullets]
        lines.append("")
    return "\n".join(lines)


def notes_text() -> str:
    lines = ["飞天探微第三次例会 · 速记（未整理）", ""]
    for speaker, text in NOTES_LINES:
        lines.append(f"{speaker}：{text}")
    return "\n".join(lines)


def tasks_text() -> str:
    lines = ["飞天探微 · 本轮任务清单（10/22 会后）", ""]
    lines.append("任务 | 负责人 | 预计工时 | 截止日期")
    for row in TASK_ROWS:
        lines.append(" | ".join(row))
    lines.append("")
    lines.append("说明：负责人固定，排不开就延期，不允许转给别人。")
    return "\n".join(lines)


def main() -> None:
    (OUT / "feitian-2026-10-22-formal.txt").write_text(formal_text(), encoding="utf-8")
    (OUT / "feitian-2026-10-22-notes.txt").write_text(notes_text(), encoding="utf-8")
    (OUT / "feitian-2026-10-22-tasks.txt").write_text(tasks_text(), encoding="utf-8")

    write_docx(OUT / "feitian-2026-10-22-formal.docx", FORMAL_TITLE, FORMAL_BODY, with_table=True)
    write_docx(
        OUT / "feitian-2026-10-22-notes.docx",
        "飞天探微第三次例会 · 速记",
        [("原始发言", [f"{s}：{t}" for s, t in NOTES_LINES])],
    )
    print("生成完成：", OUT)


if __name__ == "__main__":
    main()
