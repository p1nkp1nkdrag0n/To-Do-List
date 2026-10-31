import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
  type ScheduleTestUser,
} from "./schedule-fixture.js";

const control = vi.hoisted(() => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    gate,
    seen,
    release: () => release(),
    entered: () => entered(),
  };
});

vi.mock("../../../server/meeting/asr-correct.js", () => ({
  correctTranscript: async ({ text }: { text: string }) => {
    control.entered();
    await control.gate;
    return text;
  },
}));

vi.mock("../../../server/meeting/extractor.js", () => ({
  extractTasksFromText: async () => ({ tasks: [], warnings: [] }),
}));

describe("meeting draft version boundary", () => {
  let fixture: ScheduleFixture;
  let leader: ScheduleTestUser;

  beforeEach(async () => {
    fixture = createScheduleFixture();
    leader = await fixture.bootstrap();
  });

  afterEach(() => fixture.close());

  it("生成期间版本被推进：响应仍携带生成开始前的版本", async () => {
    const member = await fixture.register("draft-race-member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);
    const before = fixture.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id = ?",
      [project.id],
    )!.schedule_revision;

    const pending = leader.agent
      .post("/api/meeting/draft")
      .send({
        projectId: project.id,
        minutes: "生成期间版本变化的测试",
      })
      .then((response) => response);

    // 等路由进入 correctTranscript 的 await，再推进排期版本。
    await control.seen;
    fixture.database.run("UPDATE projects SET schedule_revision = schedule_revision + 1 WHERE id = ?", [
      project.id,
    ]);
    control.release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.scheduleRevision).toBe(before);
    expect(
      fixture.database.get<{ schedule_revision: number }>(
        "SELECT schedule_revision FROM projects WHERE id = ?",
        [project.id],
      )!.schedule_revision,
    ).toBe(before + 1);
  });
});
