import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createDatabase } from "./db.js";
import { createApp } from "./app.js";
import { createRegistrationInvite, userCount } from "./registration.js";

const testBootstrapCode = "test-bootstrap-code";
process.env.BOOTSTRAP_CODE = testBootstrapCode;

async function setup() {
  const db = await createDatabase(null);
  const app = createApp(db, {
    broadcastProject() {},
    broadcastUser() {}
  });
  app.locals.db = db;
  return { db, app };
}

async function register(app, username) {
  const registrationCode = userCount(app.locals.db) === 0
    ? testBootstrapCode
    : (await createRegistrationInvite(app.locals.db)).code;
  const response = await request(app)
    .post("/api/auth/register")
    .send({ username, password: "secret123", displayName: username.toUpperCase(), registrationCode })
    .expect(201);
  return response.body;
}

test("registration requires bootstrap or one-time invite codes", async () => {
  const { app, db } = await setup();

  await request(app)
    .post("/api/auth/register")
    .send({ username: "nocode", password: "secret123", displayName: "No Code" })
    .expect(400);

  await request(app)
    .post("/api/auth/register")
    .send({ username: "wrongcode", password: "secret123", displayName: "Wrong Code", registrationCode: "wrong" })
    .expect(403);

  await request(app)
    .post("/api/auth/register")
    .send({ username: "firstadmin", password: "secret123", displayName: "First Admin", registrationCode: testBootstrapCode })
    .expect(201);

  const invite = await createRegistrationInvite(db);

  const invited = await request(app)
    .post("/api/auth/register")
    .send({ username: "invited", password: "secret123", displayName: "Invited", registrationCode: invite.code })
    .expect(201);

  await request(app)
    .post("/api/auth/register")
    .send({ username: "reused", password: "secret123", displayName: "Reused", registrationCode: invite.code })
    .expect(403);

  const inviteRow = db.get("SELECT used_at AS usedAt, used_by AS usedBy FROM registration_invites WHERE id = ?", [invite.id]);
  assert.ok(inviteRow.usedAt);
  assert.equal(inviteRow.usedBy, invited.body.user.id);
});

test("auth, permissions, project CRUD and assignment sync", async () => {
  const { app } = await setup();
  const admin = await register(app, "admin");
  const member = await register(app, "member");

  const projectResponse = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Launch", timezone: "Asia/Shanghai" })
    .expect(201);
  const projectId = projectResponse.body.project.id;

  await request(app)
    .post(`/api/projects/${projectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "member", role: "member" })
    .expect(201);

  await request(app)
    .post(`/api/projects/${projectId}/tasks`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({ title: "Should fail" })
    .expect(403);

  const taskResponse = await request(app)
    .post(`/api/projects/${projectId}/tasks`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ title: "Design", status: "todo" })
    .expect(201);
  const taskId = taskResponse.body.tasks[0].id;

  await request(app)
    .post(`/api/projects/${projectId}/milestones`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ taskId, date: "2026-06-20", title: "Review", color: "#e11d48" })
    .expect(201);

  const assignmentResponse = await request(app)
    .post(`/api/projects/${projectId}/assignments`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ taskId, userId: member.user.id, startDate: "2026-06-18", endDate: "2026-06-21", status: "doing" })
    .expect(201);
  const assignment = assignmentResponse.body.assignments[0];

  const personalResponse = await request(app)
    .get("/api/personal/events")
    .set("Authorization", `Bearer ${member.token}`)
    .expect(200);
  assert.equal(personalResponse.body.events.length, 1);
  assert.equal(personalResponse.body.events[0].isTeamEvent, true);
  assert.equal(personalResponse.body.events[0].allDay, true);

  const requestResponse = await request(app)
    .post(`/api/projects/${projectId}/requests`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({ type: "assignment_update", assignmentId: assignment.id, startDate: "2026-06-19", endDate: "2026-06-22", status: "done" })
    .expect(201);
  const changeRequest = requestResponse.body.requests.find((item) => item.status === "pending");

  const approvedResponse = await request(app)
    .post(`/api/projects/${projectId}/requests/${changeRequest.id}/approve`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({})
    .expect(200);

  const updatedAssignment = approvedResponse.body.assignments.find((item) => item.id === assignment.id);
  assert.equal(updatedAssignment.startDate, "2026-06-19");
  assert.equal(updatedAssignment.endDate, "2026-06-22");
  assert.equal(updatedAssignment.status, "done");
});

test("personal event can request a new team task through approval", async () => {
  const { app } = await setup();
  const admin = await register(app, "owner");
  const member = await register(app, "teammate");

  const project = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Ops" })
    .expect(201);
  const projectId = project.body.project.id;

  await request(app)
    .post(`/api/projects/${projectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "teammate" })
    .expect(201);

  await request(app)
    .post("/api/personal/events")
    .set("Authorization", `Bearer ${member.token}`)
    .send({ title: "Research spike", startAt: "2026-06-17T09:00", endAt: "2026-06-17T11:00", allDay: false })
    .expect(201);

  const events = await request(app)
    .get("/api/personal/events")
    .set("Authorization", `Bearer ${member.token}`)
    .expect(200);
  const eventId = events.body.events[0].id;

  const requestResponse = await request(app)
    .post(`/api/projects/${projectId}/requests`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({
      type: "personal_to_team_task",
      eventId,
      title: "Research spike",
      startDate: "2026-06-17",
      endDate: "2026-06-17",
      status: "todo"
    })
    .expect(201);
  const changeRequest = requestResponse.body.requests.find((item) => item.type === "personal_to_team_task");

  const approved = await request(app)
    .post(`/api/projects/${projectId}/requests/${changeRequest.id}/approve`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({})
    .expect(200);

  assert.equal(approved.body.tasks.length, 1);
  assert.equal(approved.body.assignments.length, 1);
  assert.equal(approved.body.assignments[0].userId, member.user.id);
});

test("project state exposes personal busy totals without details for members", async () => {
  const { app } = await setup();
  const admin = await register(app, "loadadmin");
  const member = await register(app, "loadmember");

  const project = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Load" })
    .expect(201);
  const projectId = project.body.project.id;

  await request(app)
    .post(`/api/projects/${projectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "loadmember" })
    .expect(201);

  await request(app)
    .post("/api/personal/events")
    .set("Authorization", `Bearer ${member.token}`)
    .send({ title: "Cross day", startAt: "2026-06-17T22:00", endAt: "2026-06-18T02:30", allDay: false })
    .expect(201);

  await request(app)
    .post("/api/personal/events")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ title: "Focus days", startAt: "2026-06-18T00:00", endAt: "2026-06-20T00:00", allDay: true })
    .expect(201);

  const memberView = await request(app)
    .get(`/api/projects/${projectId}`)
    .set("Authorization", `Bearer ${member.token}`)
    .expect(200);

  assert.equal(memberView.body.busySlots.length, 0);
  assert.equal(memberView.body.busyDailyTotals.some((item) => "startAt" in item || "title" in item), false);

  const memberTotals = memberView.body.busyDailyTotals.filter((item) => item.userId === member.user.id);
  assert.deepEqual(
    memberTotals.map((item) => [item.date, item.hours]),
    [["2026-06-17", 2], ["2026-06-18", 2.5]]
  );

  const adminTotals = memberView.body.busyDailyTotals.filter((item) => item.userId === admin.user.id);
  assert.deepEqual(
    adminTotals.map((item) => [item.date, item.hours]),
    [["2026-06-18", 12], ["2026-06-19", 12]]
  );

  const adminView = await request(app)
    .get(`/api/projects/${projectId}`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);

  assert.equal(adminView.body.busySlots.length, 2);
  assert.equal(adminView.body.busyDailyTotals.length, memberView.body.busyDailyTotals.length);
});

test("creating another project does not clear or leak existing project content", async () => {
  const { app } = await setup();
  const admin = await register(app, "multiadmin");
  const member = await register(app, "multimember");

  const firstProject = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Project One" })
    .expect(201);
  const firstProjectId = firstProject.body.project.id;

  await request(app)
    .post(`/api/projects/${firstProjectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "multimember" })
    .expect(201);

  const firstTaskState = await request(app)
    .post(`/api/projects/${firstProjectId}/tasks`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ title: "Keep me", status: "doing" })
    .expect(201);
  const firstTaskId = firstTaskState.body.tasks[0].id;

  await request(app)
    .post(`/api/projects/${firstProjectId}/assignments`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ taskId: firstTaskId, userId: member.user.id, startDate: "2026-06-17", endDate: "2026-06-18", status: "doing" })
    .expect(201);

  await request(app)
    .post(`/api/projects/${firstProjectId}/milestones`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ taskId: firstTaskId, date: "2026-06-19", title: "Keep marker", color: "#5b8cff" })
    .expect(201);

  const secondProject = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Project Two" })
    .expect(201);
  const secondProjectId = secondProject.body.project.id;

  assert.notEqual(secondProjectId, firstProjectId);
  assert.equal(secondProject.body.tasks.length, 0);
  assert.equal(secondProject.body.assignments.length, 0);
  assert.equal(secondProject.body.milestones.length, 0);

  const firstAfterSecond = await request(app)
    .get(`/api/projects/${firstProjectId}`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);

  assert.equal(firstAfterSecond.body.tasks.length, 1);
  assert.equal(firstAfterSecond.body.tasks[0].title, "Keep me");
  assert.equal(firstAfterSecond.body.assignments.length, 1);
  assert.equal(firstAfterSecond.body.milestones.length, 1);

  const projectList = await request(app)
    .get("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);

  assert.deepEqual(
    projectList.body.projects.map((project) => project.name).sort(),
    ["Project One", "Project Two"]
  );
});

test("knowledge base permissions and project isolation", async () => {
  const { app } = await setup();
  const admin = await register(app, "kbadmin");
  const member = await register(app, "kbmember");
  const outsider = await register(app, "kboutsider");

  const firstProject = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Knowledge One" })
    .expect(201);
  const firstProjectId = firstProject.body.project.id;

  await request(app)
    .post(`/api/projects/${firstProjectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "kbmember" })
    .expect(201);

  const secondProject = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Knowledge Two" })
    .expect(201);
  const secondProjectId = secondProject.body.project.id;

  const categoryResponse = await request(app)
    .post(`/api/projects/${firstProjectId}/knowledge/categories`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "研发资料" })
    .expect(201);
  const categoryId = categoryResponse.body.categories[0].id;

  const documentResponse = await request(app)
    .post(`/api/projects/${firstProjectId}/knowledge/documents`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ categoryId, title: "接口说明", content: "# API\n- 登录\n- 项目" })
    .expect(201);
  const documentId = documentResponse.body.documents[0].id;

  await request(app)
    .post(`/api/projects/${firstProjectId}/knowledge/documents`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({ title: "Should fail", content: "member direct write" })
    .expect(403);

  await request(app)
    .get(`/api/projects/${firstProjectId}/knowledge`)
    .set("Authorization", `Bearer ${outsider.token}`)
    .expect(403);

  const memberView = await request(app)
    .get(`/api/projects/${firstProjectId}/knowledge`)
    .set("Authorization", `Bearer ${member.token}`)
    .expect(200);
  assert.equal(memberView.body.categories.length, 1);
  assert.equal(memberView.body.documents.length, 1);
  assert.equal(memberView.body.documents[0].title, "接口说明");

  const isolatedView = await request(app)
    .get(`/api/projects/${secondProjectId}/knowledge`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);
  assert.equal(isolatedView.body.categories.length, 0);
  assert.equal(isolatedView.body.documents.length, 0);

  const afterDeleteCategory = await request(app)
    .delete(`/api/projects/${firstProjectId}/knowledge/categories/${categoryId}`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);
  assert.equal(afterDeleteCategory.body.documents.find((item) => item.id === documentId).categoryId, null);
});

test("member knowledge requests create and update documents after approval", async () => {
  const { app } = await setup();
  const admin = await register(app, "kbowner");
  const member = await register(app, "kbwriter");

  const project = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "Knowledge Flow" })
    .expect(201);
  const projectId = project.body.project.id;

  await request(app)
    .post(`/api/projects/${projectId}/members`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ username: "kbwriter" })
    .expect(201);

  const categoryResponse = await request(app)
    .post(`/api/projects/${projectId}/knowledge/categories`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ name: "方案" })
    .expect(201);
  const categoryId = categoryResponse.body.categories[0].id;

  const createRequestResponse = await request(app)
    .post(`/api/projects/${projectId}/requests`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({ type: "knowledge_document_create", categoryId, title: "发布流程", content: "## 步骤\n- 构建\n- 验收" })
    .expect(201);
  const createRequest = createRequestResponse.body.requests.find((item) => item.type === "knowledge_document_create");

  await request(app)
    .post(`/api/projects/${projectId}/requests/${createRequest.id}/approve`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({})
    .expect(200);

  const afterCreate = await request(app)
    .get(`/api/projects/${projectId}/knowledge`)
    .set("Authorization", `Bearer ${member.token}`)
    .expect(200);
  assert.equal(afterCreate.body.documents.length, 1);
  assert.equal(afterCreate.body.documents[0].title, "发布流程");
  assert.equal(afterCreate.body.documents[0].createdBy, member.user.id);
  const documentId = afterCreate.body.documents[0].id;

  const updateRequestResponse = await request(app)
    .post(`/api/projects/${projectId}/requests`)
    .set("Authorization", `Bearer ${member.token}`)
    .send({ type: "knowledge_document_update", documentId, categoryId: null, title: "发布流程 v2", content: "已更新" })
    .expect(201);
  const updateRequest = updateRequestResponse.body.requests.find((item) => item.type === "knowledge_document_update");

  await request(app)
    .post(`/api/projects/${projectId}/requests/${updateRequest.id}/approve`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({})
    .expect(200);

  const afterUpdate = await request(app)
    .get(`/api/projects/${projectId}/knowledge`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);
  assert.equal(afterUpdate.body.documents.length, 1);
  assert.equal(afterUpdate.body.documents[0].title, "发布流程 v2");
  assert.equal(afterUpdate.body.documents[0].content, "已更新");
  assert.equal(afterUpdate.body.documents[0].categoryId, null);
});
