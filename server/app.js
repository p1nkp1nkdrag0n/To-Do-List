import express from "express";
import crypto from "node:crypto";
import { createToken, hashPassword, verifyPassword, verifyToken } from "./security.js";
import { markInviteUsed, markInviteUser, resolveRegistrationCode } from "./registration.js";

const memberColors = ["#2f7de1", "#24a148", "#f97316", "#8b5cf6", "#e11d48", "#0f766e", "#ca8a04", "#64748b"];
const statuses = new Set(["todo", "doing", "done"]);
const dailyCapacityHours = 12;

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function compareDates(a, b) {
  return a.localeCompare(b);
}

function parseDateTimeMs(value) {
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour || 0, minute || 0);
}

function dateStartMs(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function eventEndExclusiveDate(event) {
  const endDate = event.endAt.slice(0, 10);
  const endTime = event.endAt.slice(11, 16);
  if (event.allDay && endTime === "00:00") {
    return compareDates(endDate, event.startAt.slice(0, 10)) > 0 ? endDate : addDays(endDate, 1);
  }
  return addDays(endDate, 1);
}

function dateOnly(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, "Date must use YYYY-MM-DD.");
  }
  return value;
}

function dateTime(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw httpError(400, "Date time must use YYYY-MM-DDTHH:mm.");
  }
  return value;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function markdownText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function status(value, fallback = "todo") {
  const next = value || fallback;
  if (!statuses.has(next)) {
    throw httpError(400, "Invalid status.");
  }
  return next;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireValidRegistration(registration) {
  if (registration.ok) {
    return registration;
  }
  if (registration.reason === "missing") {
    throw httpError(400, "Registration code is required.");
  }
  if (registration.reason === "bootstrap_unconfigured") {
    throw httpError(503, "Bootstrap registration code is not configured.");
  }
  throw httpError(403, "Invalid registration code.");
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function publicUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name
  };
}

function getBearerToken(req) {
  const authorization = req.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function getMembership(db, projectId, userId) {
  return db.get(
    `SELECT pm.project_id AS projectId, pm.user_id AS userId, pm.role, pm.color,
            u.username, u.display_name AS displayName
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? AND pm.user_id = ?`,
    [projectId, userId]
  );
}

function requireMember(db, projectId, userId) {
  const membership = getMembership(db, projectId, userId);
  if (!membership) {
    throw httpError(403, "Project membership is required.");
  }
  return membership;
}

function requireAdmin(db, projectId, userId) {
  const membership = requireMember(db, projectId, userId);
  if (membership.role !== "admin") {
    throw httpError(403, "Project admin permission is required.");
  }
  return membership;
}

function countAdmins(db, projectId) {
  return db.get("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'admin'", [projectId]).count;
}

function projectTask(db, projectId, taskId) {
  return db.get("SELECT * FROM tasks WHERE project_id = ? AND id = ?", [projectId, taskId]);
}

function projectAssignment(db, projectId, assignmentId) {
  return db.get("SELECT * FROM assignments WHERE project_id = ? AND id = ?", [projectId, assignmentId]);
}

function knowledgeCategory(db, projectId, categoryId) {
  if (!categoryId) {
    return null;
  }
  return db.get("SELECT * FROM knowledge_categories WHERE project_id = ? AND id = ?", [projectId, categoryId]);
}

function knowledgeDocument(db, projectId, documentId) {
  return db.get("SELECT * FROM knowledge_documents WHERE project_id = ? AND id = ?", [projectId, documentId]);
}

function normalizeKnowledgeCategoryId(db, projectId, categoryId, required = true) {
  const value = categoryId || null;
  if (!value) {
    return null;
  }
  if (!knowledgeCategory(db, projectId, value)) {
    if (required) {
      throw httpError(404, "Knowledge category not found.");
    }
    return null;
  }
  return value;
}

function toKnowledgeState(db, projectId, currentUserId) {
  requireMember(db, projectId, currentUserId);
  const categories = db.all(
    `SELECT kc.id, kc.project_id AS projectId, kc.name, kc.position,
            kc.created_by AS createdBy, kc.created_at AS createdAt, kc.updated_at AS updatedAt,
            creator.display_name AS createdByName
       FROM knowledge_categories kc
       LEFT JOIN users creator ON creator.id = kc.created_by
      WHERE kc.project_id = ?
      ORDER BY kc.position, kc.created_at`,
    [projectId]
  );
  const documents = db.all(
    `SELECT kd.id, kd.project_id AS projectId, kd.category_id AS categoryId, kd.title, kd.content,
            kd.created_by AS createdBy, kd.updated_by AS updatedBy,
            kd.created_at AS createdAt, kd.updated_at AS updatedAt,
            creator.display_name AS createdByName, updater.display_name AS updatedByName
       FROM knowledge_documents kd
       LEFT JOIN users creator ON creator.id = kd.created_by
       LEFT JOIN users updater ON updater.id = kd.updated_by
      WHERE kd.project_id = ?
      ORDER BY kd.updated_at DESC, kd.created_at DESC`,
    [projectId]
  );
  return { projectId, categories, documents };
}

async function createKnowledgeDocument(db, projectId, actorId, payload, createdBy = actorId, categoryRequired = true) {
  const title = text(payload.title);
  if (!title) {
    throw httpError(400, "Knowledge document title is required.");
  }
  const categoryId = normalizeKnowledgeCategoryId(db, projectId, payload.categoryId, categoryRequired);
  const documentId = id();
  const current = now();
  await db.run(
    `INSERT INTO knowledge_documents
     (id, project_id, category_id, title, content, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [documentId, projectId, categoryId, title, markdownText(payload.content), createdBy, actorId, current, current]
  );
  return documentId;
}

async function updateKnowledgeDocument(db, projectId, documentId, actorId, payload, categoryRequired = true) {
  const document = knowledgeDocument(db, projectId, documentId);
  if (!document) {
    throw httpError(404, "Knowledge document not found.");
  }
  const title = text(payload.title, document.title);
  if (!title) {
    throw httpError(400, "Knowledge document title is required.");
  }
  const categoryId = Object.hasOwn(payload, "categoryId")
    ? normalizeKnowledgeCategoryId(db, projectId, payload.categoryId, categoryRequired)
    : document.category_id || null;
  await db.run(
    `UPDATE knowledge_documents
        SET category_id = ?, title = ?, content = ?, updated_by = ?, updated_at = ?
      WHERE id = ?`,
    [categoryId, title, markdownText(payload.content, document.content), actorId, now(), documentId]
  );
}

async function syncTeamPersonalEvent(db, assignmentId) {
  const assignment = db.get(
    `SELECT a.*, t.title AS taskTitle
       FROM assignments a
       JOIN tasks t ON t.id = a.task_id
      WHERE a.id = ?`,
    [assignmentId]
  );
  if (!assignment) {
    return;
  }

  const current = now();
  const event = db.get("SELECT id FROM personal_events WHERE assignment_id = ?", [assignmentId]);
  const startAt = `${assignment.start_date}T00:00`;
  const endAt = `${addDays(assignment.end_date, 1)}T00:00`;
  if (event) {
    await db.run(
      `UPDATE personal_events
          SET user_id = ?, project_id = ?, title = ?, start_at = ?, end_at = ?,
              all_day = 1, is_team_event = 1, updated_at = ?
        WHERE id = ?`,
      [assignment.user_id, assignment.project_id, assignment.taskTitle, startAt, endAt, current, event.id]
    );
    return;
  }
  await db.run(
    `INSERT INTO personal_events
      (id, user_id, project_id, assignment_id, title, start_at, end_at, all_day, is_team_event, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    [id(), assignment.user_id, assignment.project_id, assignment.id, assignment.taskTitle, startAt, endAt, current, current]
  );
}

async function deleteAssignment(db, assignmentId) {
  await db.run("DELETE FROM personal_events WHERE assignment_id = ?", [assignmentId]);
  await db.run("DELETE FROM assignments WHERE id = ?", [assignmentId]);
}

function personalBusyDailyTotals(db, projectId) {
  const events = db.all(
    `SELECT pe.user_id AS userId, pe.start_at AS startAt, pe.end_at AS endAt, pe.all_day AS allDay
       FROM personal_events pe
       JOIN project_members pm ON pm.user_id = pe.user_id
      WHERE pm.project_id = ?
        AND pe.is_team_event = 0
      ORDER BY pe.start_at`,
    [projectId]
  ).map((event) => ({ ...event, allDay: Boolean(event.allDay) }));
  const totals = new Map();

  for (const event of events) {
    if (event.allDay) {
      let date = event.startAt.slice(0, 10);
      const endExclusive = eventEndExclusiveDate(event);
      while (compareDates(date, endExclusive) < 0) {
        const key = `${event.userId}|${date}`;
        totals.set(key, (totals.get(key) || 0) + dailyCapacityHours);
        date = addDays(date, 1);
      }
      continue;
    }

    const startMs = parseDateTimeMs(event.startAt);
    const endMs = parseDateTimeMs(event.endAt);
    if (endMs <= startMs) {
      continue;
    }
    let date = event.startAt.slice(0, 10);
    const endDate = event.endAt.slice(0, 10);
    while (compareDates(date, addDays(endDate, 1)) < 0) {
      const dayStart = dateStartMs(date);
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const overlapMs = Math.min(endMs, dayEnd) - Math.max(startMs, dayStart);
      if (overlapMs > 0) {
        const hours = Math.round((overlapMs / 3600000) * 100) / 100;
        const key = `${event.userId}|${date}`;
        totals.set(key, (totals.get(key) || 0) + hours);
      }
      date = addDays(date, 1);
    }
  }

  return [...totals.entries()]
    .map(([key, hours]) => {
      const [userId, date] = key.split("|");
      return { userId, date, hours: Math.round(hours * 100) / 100 };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.userId.localeCompare(b.userId));
}

function toProjectState(db, projectId, currentUserId) {
  const project = db.get(
    `SELECT id, name, timezone, owner_id AS ownerId, created_at AS createdAt, updated_at AS updatedAt
       FROM projects
      WHERE id = ?`,
    [projectId]
  );
  if (!project) {
    throw httpError(404, "Project not found.");
  }
  const currentMember = requireMember(db, projectId, currentUserId);
  const members = db.all(
    `SELECT pm.user_id AS userId, pm.role, pm.color, pm.joined_at AS joinedAt,
            u.username, u.display_name AS displayName
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ?
      ORDER BY pm.role, u.display_name`,
    [projectId]
  );
  const tasks = db.all(
    `SELECT id, project_id AS projectId, parent_id AS parentId, title, description, status,
            position, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
       FROM tasks
      WHERE project_id = ?
      ORDER BY position, created_at`,
    [projectId]
  );
  const assignments = db.all(
    `SELECT a.id, a.project_id AS projectId, a.task_id AS taskId, a.user_id AS userId,
            a.start_date AS startDate, a.end_date AS endDate, a.status,
            a.created_by AS createdBy, a.created_at AS createdAt, a.updated_at AS updatedAt,
            u.username, u.display_name AS displayName, pm.color
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = a.user_id
      WHERE a.project_id = ?
      ORDER BY a.start_date, u.display_name`,
    [projectId]
  );
  const milestones = db.all(
    `SELECT id, project_id AS projectId, task_id AS taskId, date, title, color,
            created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
       FROM milestones
      WHERE project_id = ?
      ORDER BY date, title`,
    [projectId]
  );
  const requests = db.all(
    `SELECT cr.id, cr.project_id AS projectId, cr.requester_id AS requesterId, cr.type,
            cr.target_id AS targetId, cr.payload, cr.status, cr.reviewer_id AS reviewerId,
            cr.review_note AS reviewNote, cr.created_at AS createdAt, cr.updated_at AS updatedAt,
            requester.username AS requesterUsername, requester.display_name AS requesterDisplayName,
            reviewer.username AS reviewerUsername, reviewer.display_name AS reviewerDisplayName
       FROM change_requests cr
       JOIN users requester ON requester.id = cr.requester_id
       LEFT JOIN users reviewer ON reviewer.id = cr.reviewer_id
      WHERE cr.project_id = ?
      ORDER BY cr.status = 'pending' DESC, cr.created_at DESC`,
    [projectId]
  ).map((request) => ({ ...request, payload: JSON.parse(request.payload) }));

  const busySlots = currentMember.role === "admin"
    ? db.all(
      `SELECT pe.user_id AS userId, pe.start_at AS startAt, pe.end_at AS endAt, pe.all_day AS allDay
         FROM personal_events pe
         JOIN project_members pm ON pm.user_id = pe.user_id
        WHERE pm.project_id = ?
          AND pe.is_team_event = 0
        ORDER BY pe.start_at`,
      [projectId]
    ).map((slot) => ({ ...slot, allDay: Boolean(slot.allDay), title: "忙碌" }))
    : [];

  return {
    project,
    currentMember,
    members,
    tasks,
    assignments,
    milestones,
    requests,
    busySlots,
    busyDailyTotals: personalBusyDailyTotals(db, projectId)
  };
}

function pickMemberColor(db, projectId) {
  const count = db.get("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?", [projectId]).count;
  return memberColors[count % memberColors.length];
}

function eventDatesFromPayload(payload, event) {
  const startDate = payload.startDate ? dateOnly(payload.startDate) : dateTime(event.start_at).slice(0, 10);
  const endDate = payload.endDate ? dateOnly(payload.endDate) : dateTime(event.end_at).slice(0, 10);
  return { startDate, endDate: endDate < startDate ? startDate : endDate };
}

function userProjectIds(db, userId) {
  return db.all("SELECT project_id AS projectId FROM project_members WHERE user_id = ?", [userId]).map((row) => row.projectId);
}

export function createApp(db, realtime = {}) {
  const app = express();
  const broadcastProject = realtime.broadcastProject || (() => {});
  const broadcastUser = realtime.broadcastUser || (() => {});

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (req, res) => {
    res.json({ ok: true, timestamp: now(), uptime: process.uptime() });
  });

  app.post("/api/auth/register", asyncRoute(async (req, res) => {
    const username = text(req.body.username).toLowerCase();
    const password = String(req.body.password || "");
    const displayName = text(req.body.displayName, username);
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      throw httpError(400, "Username must be 3-32 characters and use letters, numbers, dots, dashes or underscores.");
    }
    if (password.length < 6) {
      throw httpError(400, "Password must be at least 6 characters.");
    }
    await db.reloadIfChanged?.();
    if (db.get("SELECT id FROM users WHERE username = ?", [username])) {
      throw httpError(409, "Username is already taken.");
    }
    requireValidRegistration(resolveRegistrationCode(db, req.body.registrationCode));
    const user = { id: id(), username, display_name: displayName };
    const current = now();
    const passwordHash = await hashPassword(password);
    await db.reloadIfChanged?.();
    if (db.get("SELECT id FROM users WHERE username = ?", [username])) {
      throw httpError(409, "Username is already taken.");
    }
    const registration = requireValidRegistration(resolveRegistrationCode(db, req.body.registrationCode));
    if (registration.inviteId && !(await markInviteUsed(db, registration.inviteId))) {
      throw httpError(403, "Invalid registration code.");
    }
    await db.run(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
      [user.id, username, passwordHash, displayName, current]
    );
    await markInviteUser(db, registration.inviteId, user.id);
    res.status(201).json({ user: publicUser(user), token: createToken(user) });
  }));

  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const username = text(req.body.username).toLowerCase();
    const password = String(req.body.password || "");
    const user = db.get("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw httpError(401, "Invalid username or password.");
    }
    res.json({ user: publicUser(user), token: createToken(user) });
  }));

  app.use("/api", asyncRoute(async (req, res, next) => {
    const token = verifyToken(getBearerToken(req));
    if (!token) {
      throw httpError(401, "Authentication is required.");
    }
    const user = db.get("SELECT * FROM users WHERE id = ?", [token.userId]);
    if (!user) {
      throw httpError(401, "User no longer exists.");
    }
    req.user = user;
    next();
  }));

  app.get("/api/auth/me", (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.get("/api/users/search", (req, res) => {
    const query = `%${text(req.query.q).toLowerCase()}%`;
    const users = db.all(
      `SELECT id, username, display_name
         FROM users
        WHERE lower(username) LIKE ? OR lower(display_name) LIKE ?
        ORDER BY username
        LIMIT 10`,
      [query, query]
    ).map(publicUser);
    res.json({ users });
  });

  app.get("/api/projects", (req, res) => {
    const projects = db.all(
      `SELECT p.id, p.name, p.timezone, p.owner_id AS ownerId, p.created_at AS createdAt,
              p.updated_at AS updatedAt, pm.role, pm.color
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
        WHERE pm.user_id = ?
        ORDER BY p.updated_at DESC`,
      [req.user.id]
    );
    res.json({ projects });
  });

  app.post("/api/projects", asyncRoute(async (req, res) => {
    const name = text(req.body.name);
    const timezone = text(req.body.timezone, "Asia/Shanghai") || "Asia/Shanghai";
    if (!name) {
      throw httpError(400, "Project name is required.");
    }
    const projectId = id();
    const current = now();
    await db.run(
      "INSERT INTO projects (id, name, timezone, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [projectId, name, timezone, req.user.id, current, current]
    );
    await db.run(
      "INSERT INTO project_members (project_id, user_id, role, color, joined_at) VALUES (?, ?, 'admin', ?, ?)",
      [projectId, req.user.id, memberColors[0], current]
    );
    res.status(201).json(toProjectState(db, projectId, req.user.id));
  }));

  app.get("/api/projects/:projectId", (req, res) => {
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  });

  app.patch("/api/projects/:projectId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const name = text(req.body.name);
    const timezone = text(req.body.timezone, "Asia/Shanghai") || "Asia/Shanghai";
    if (!name) {
      throw httpError(400, "Project name is required.");
    }
    await db.run("UPDATE projects SET name = ?, timezone = ?, updated_at = ? WHERE id = ?", [name, timezone, now(), req.params.projectId]);
    broadcastProject(req.params.projectId, "project:updated");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.get("/api/projects/:projectId/knowledge", (req, res) => {
    res.json(toKnowledgeState(db, req.params.projectId, req.user.id));
  });

  app.post("/api/projects/:projectId/knowledge/categories", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const name = text(req.body.name);
    if (!name) {
      throw httpError(400, "Knowledge category name is required.");
    }
    const categoryId = id();
    const current = now();
    const position = db.get("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM knowledge_categories WHERE project_id = ?", [req.params.projectId]).next;
    await db.run(
      `INSERT INTO knowledge_categories
       (id, project_id, name, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [categoryId, req.params.projectId, name, position, req.user.id, current, current]
    );
    broadcastProject(req.params.projectId, "knowledge:category:created");
    res.status(201).json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/knowledge/categories/:categoryId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!knowledgeCategory(db, req.params.projectId, req.params.categoryId)) {
      throw httpError(404, "Knowledge category not found.");
    }
    const name = text(req.body.name);
    if (!name) {
      throw httpError(400, "Knowledge category name is required.");
    }
    await db.run(
      "UPDATE knowledge_categories SET name = ?, updated_at = ? WHERE project_id = ? AND id = ?",
      [name, now(), req.params.projectId, req.params.categoryId]
    );
    broadcastProject(req.params.projectId, "knowledge:category:updated");
    res.json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/knowledge/categories/:categoryId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!knowledgeCategory(db, req.params.projectId, req.params.categoryId)) {
      throw httpError(404, "Knowledge category not found.");
    }
    await db.run(
      "UPDATE knowledge_documents SET category_id = NULL, updated_at = ? WHERE project_id = ? AND category_id = ?",
      [now(), req.params.projectId, req.params.categoryId]
    );
    await db.run("DELETE FROM knowledge_categories WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.categoryId]);
    broadcastProject(req.params.projectId, "knowledge:category:deleted");
    res.json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/knowledge/documents", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    await createKnowledgeDocument(db, req.params.projectId, req.user.id, req.body);
    broadcastProject(req.params.projectId, "knowledge:document:created");
    res.status(201).json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/knowledge/documents/:documentId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    await updateKnowledgeDocument(db, req.params.projectId, req.params.documentId, req.user.id, req.body);
    broadcastProject(req.params.projectId, "knowledge:document:updated");
    res.json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/knowledge/documents/:documentId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!knowledgeDocument(db, req.params.projectId, req.params.documentId)) {
      throw httpError(404, "Knowledge document not found.");
    }
    await db.run("DELETE FROM knowledge_documents WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.documentId]);
    broadcastProject(req.params.projectId, "knowledge:document:deleted");
    res.json(toKnowledgeState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/members", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const username = text(req.body.username).toLowerCase();
    const role = req.body.role === "admin" ? "admin" : "member";
    const user = db.get("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) {
      throw httpError(404, "User not found.");
    }
    if (getMembership(db, req.params.projectId, user.id)) {
      throw httpError(409, "User is already a project member.");
    }
    await db.run(
      "INSERT INTO project_members (project_id, user_id, role, color, joined_at) VALUES (?, ?, ?, ?, ?)",
      [req.params.projectId, user.id, role, pickMemberColor(db, req.params.projectId), now()]
    );
    broadcastProject(req.params.projectId, "member:added");
    res.status(201).json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/members/:userId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const membership = getMembership(db, req.params.projectId, req.params.userId);
    if (!membership) {
      throw httpError(404, "Member not found.");
    }
    const nextRole = req.body.role === "admin" ? "admin" : "member";
    if (membership.role === "admin" && nextRole === "member" && countAdmins(db, req.params.projectId) <= 1) {
      throw httpError(400, "A project needs at least one admin.");
    }
    await db.run(
      "UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?",
      [nextRole, req.params.projectId, req.params.userId]
    );
    broadcastProject(req.params.projectId, "member:updated");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/members/:userId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const membership = getMembership(db, req.params.projectId, req.params.userId);
    if (!membership) {
      throw httpError(404, "Member not found.");
    }
    if (membership.role === "admin" && countAdmins(db, req.params.projectId) <= 1) {
      throw httpError(400, "A project needs at least one admin.");
    }
    await db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [req.params.projectId, req.params.userId]);
    broadcastProject(req.params.projectId, "member:removed");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/tasks", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const title = text(req.body.title);
    if (!title) {
      throw httpError(400, "Task title is required.");
    }
    const parentId = req.body.parentId || null;
    if (parentId && !projectTask(db, req.params.projectId, parentId)) {
      throw httpError(404, "Parent task not found.");
    }
    const position = db.get("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM tasks WHERE project_id = ?", [req.params.projectId]).next;
    const taskId = id();
    const current = now();
    await db.run(
      `INSERT INTO tasks
       (id, project_id, parent_id, title, description, status, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, req.params.projectId, parentId, title, text(req.body.description), status(req.body.status), position, req.user.id, current, current]
    );
    broadcastProject(req.params.projectId, "task:created");
    res.status(201).json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/tasks/:taskId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const task = projectTask(db, req.params.projectId, req.params.taskId);
    if (!task) {
      throw httpError(404, "Task not found.");
    }
    await db.run(
      "UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
      [
        text(req.body.title, task.title) || task.title,
        text(req.body.description, task.description),
        status(req.body.status, task.status),
        now(),
        req.params.taskId
      ]
    );
    broadcastProject(req.params.projectId, "task:updated");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/tasks/:taskId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!projectTask(db, req.params.projectId, req.params.taskId)) {
      throw httpError(404, "Task not found.");
    }
    await db.run("DELETE FROM tasks WHERE id = ?", [req.params.taskId]);
    broadcastProject(req.params.projectId, "task:deleted");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/assignments", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!projectTask(db, req.params.projectId, req.body.taskId)) {
      throw httpError(404, "Task not found.");
    }
    if (!getMembership(db, req.params.projectId, req.body.userId)) {
      throw httpError(404, "Member not found.");
    }
    const startDate = dateOnly(req.body.startDate);
    const endDate = dateOnly(req.body.endDate);
    if (endDate < startDate) {
      throw httpError(400, "End date must be after start date.");
    }
    const assignmentId = id();
    const current = now();
    await db.run(
      `INSERT INTO assignments
       (id, project_id, task_id, user_id, start_date, end_date, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [assignmentId, req.params.projectId, req.body.taskId, req.body.userId, startDate, endDate, status(req.body.status), req.user.id, current, current]
    );
    await syncTeamPersonalEvent(db, assignmentId);
    broadcastProject(req.params.projectId, "assignment:created");
    broadcastUser(req.body.userId, "team:event:created");
    res.status(201).json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/assignments/:assignmentId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const assignment = projectAssignment(db, req.params.projectId, req.params.assignmentId);
    if (!assignment) {
      throw httpError(404, "Assignment not found.");
    }
    const startDate = dateOnly(req.body.startDate || assignment.start_date);
    const endDate = dateOnly(req.body.endDate || assignment.end_date);
    if (endDate < startDate) {
      throw httpError(400, "End date must be after start date.");
    }
    const userId = req.body.userId || assignment.user_id;
    if (!getMembership(db, req.params.projectId, userId)) {
      throw httpError(404, "Member not found.");
    }
    await db.run(
      "UPDATE assignments SET user_id = ?, start_date = ?, end_date = ?, status = ?, updated_at = ? WHERE id = ?",
      [userId, startDate, endDate, status(req.body.status, assignment.status), now(), req.params.assignmentId]
    );
    await syncTeamPersonalEvent(db, req.params.assignmentId);
    broadcastProject(req.params.projectId, "assignment:updated");
    broadcastUser(userId, "team:event:updated");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/assignments/:assignmentId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const assignment = projectAssignment(db, req.params.projectId, req.params.assignmentId);
    if (!assignment) {
      throw httpError(404, "Assignment not found.");
    }
    await deleteAssignment(db, req.params.assignmentId);
    broadcastProject(req.params.projectId, "assignment:deleted");
    broadcastUser(assignment.user_id, "team:event:deleted");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/milestones", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    if (!projectTask(db, req.params.projectId, req.body.taskId)) {
      throw httpError(404, "Task not found.");
    }
    const title = text(req.body.title);
    if (!title) {
      throw httpError(400, "Milestone title is required.");
    }
    const milestoneId = id();
    const current = now();
    await db.run(
      `INSERT INTO milestones (id, project_id, task_id, date, title, color, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [milestoneId, req.params.projectId, req.body.taskId, dateOnly(req.body.date), title, text(req.body.color, "#e11d48"), req.user.id, current, current]
    );
    broadcastProject(req.params.projectId, "milestone:created");
    res.status(201).json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.patch("/api/projects/:projectId/milestones/:milestoneId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const milestone = db.get("SELECT * FROM milestones WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.milestoneId]);
    if (!milestone) {
      throw httpError(404, "Milestone not found.");
    }
    await db.run(
      "UPDATE milestones SET date = ?, title = ?, color = ?, updated_at = ? WHERE id = ?",
      [
        dateOnly(req.body.date || milestone.date),
        text(req.body.title, milestone.title) || milestone.title,
        text(req.body.color, milestone.color) || milestone.color,
        now(),
        req.params.milestoneId
      ]
    );
    broadcastProject(req.params.projectId, "milestone:updated");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.delete("/api/projects/:projectId/milestones/:milestoneId", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    await db.run("DELETE FROM milestones WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.milestoneId]);
    broadcastProject(req.params.projectId, "milestone:deleted");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.get("/api/personal/events", (req, res) => {
    const events = db.all(
      `SELECT id, user_id AS userId, project_id AS projectId, assignment_id AS assignmentId, title,
              start_at AS startAt, end_at AS endAt, all_day AS allDay, is_team_event AS isTeamEvent,
              created_at AS createdAt, updated_at AS updatedAt
         FROM personal_events
        WHERE user_id = ?
        ORDER BY start_at`,
      [req.user.id]
    ).map((event) => ({ ...event, allDay: Boolean(event.allDay), isTeamEvent: Boolean(event.isTeamEvent) }));
    res.json({ events });
  });

  app.post("/api/personal/events", asyncRoute(async (req, res) => {
    const title = text(req.body.title);
    if (!title) {
      throw httpError(400, "Event title is required.");
    }
    const startAt = dateTime(req.body.startAt);
    const endAt = dateTime(req.body.endAt);
    if (endAt <= startAt) {
      throw httpError(400, "End time must be after start time.");
    }
    const eventId = id();
    const current = now();
    await db.run(
      `INSERT INTO personal_events
       (id, user_id, project_id, assignment_id, title, start_at, end_at, all_day, is_team_event, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 0, ?, ?)`,
      [eventId, req.user.id, title, startAt, endAt, req.body.allDay ? 1 : 0, current, current]
    );
    broadcastUser(req.user.id, "personal:event:created");
    for (const membershipProjectId of userProjectIds(db, req.user.id)) {
      broadcastProject(membershipProjectId, "personal:busy:updated");
    }
    res.status(201).json({ events: db.all("SELECT * FROM personal_events WHERE user_id = ?", [req.user.id]) });
  }));

  app.patch("/api/personal/events/:eventId", asyncRoute(async (req, res) => {
    const event = db.get("SELECT * FROM personal_events WHERE user_id = ? AND id = ?", [req.user.id, req.params.eventId]);
    if (!event) {
      throw httpError(404, "Event not found.");
    }
    if (event.is_team_event) {
      throw httpError(403, "Team events are read-only in personal mode.");
    }
    const startAt = dateTime(req.body.startAt || event.start_at);
    const endAt = dateTime(req.body.endAt || event.end_at);
    if (endAt <= startAt) {
      throw httpError(400, "End time must be after start time.");
    }
    await db.run(
      "UPDATE personal_events SET title = ?, start_at = ?, end_at = ?, all_day = ?, updated_at = ? WHERE id = ?",
      [text(req.body.title, event.title) || event.title, startAt, endAt, req.body.allDay ? 1 : 0, now(), req.params.eventId]
    );
    broadcastUser(req.user.id, "personal:event:updated");
    for (const membershipProjectId of userProjectIds(db, req.user.id)) {
      broadcastProject(membershipProjectId, "personal:busy:updated");
    }
    res.json({ ok: true });
  }));

  app.delete("/api/personal/events/:eventId", asyncRoute(async (req, res) => {
    const event = db.get("SELECT * FROM personal_events WHERE user_id = ? AND id = ?", [req.user.id, req.params.eventId]);
    if (!event) {
      throw httpError(404, "Event not found.");
    }
    if (event.is_team_event) {
      throw httpError(403, "Team events are controlled by project admins.");
    }
    await db.run("DELETE FROM personal_events WHERE id = ?", [req.params.eventId]);
    broadcastUser(req.user.id, "personal:event:deleted");
    for (const membershipProjectId of userProjectIds(db, req.user.id)) {
      broadcastProject(membershipProjectId, "personal:busy:updated");
    }
    res.json({ ok: true });
  }));

  app.post("/api/projects/:projectId/requests", asyncRoute(async (req, res) => {
    requireMember(db, req.params.projectId, req.user.id);
    const type = text(req.body.type);
    let targetId = null;
    let payload;

    if (type === "assignment_update") {
      const assignment = projectAssignment(db, req.params.projectId, req.body.assignmentId);
      if (!assignment || assignment.user_id !== req.user.id) {
        throw httpError(404, "Assignment not found for current member.");
      }
      targetId = assignment.id;
      payload = {
        assignmentId: assignment.id,
        startDate: dateOnly(req.body.startDate || assignment.start_date),
        endDate: dateOnly(req.body.endDate || assignment.end_date),
        status: status(req.body.status, assignment.status)
      };
    } else if (type === "personal_to_team_assignment" || type === "personal_to_team_task") {
      const event = db.get("SELECT * FROM personal_events WHERE user_id = ? AND id = ? AND is_team_event = 0", [req.user.id, req.body.eventId]);
      if (!event) {
        throw httpError(404, "Personal event not found.");
      }
      targetId = event.id;
      const dates = eventDatesFromPayload(req.body, event);
      if (type === "personal_to_team_assignment") {
        if (!projectTask(db, req.params.projectId, req.body.taskId)) {
          throw httpError(404, "Task not found.");
        }
        payload = { eventId: event.id, taskId: req.body.taskId, ...dates, status: status(req.body.status, "todo") };
      } else {
        const title = text(req.body.title, event.title);
        if (!title) {
          throw httpError(400, "Task title is required.");
        }
        const parentId = req.body.parentId || null;
        if (parentId && !projectTask(db, req.params.projectId, parentId)) {
          throw httpError(404, "Parent task not found.");
        }
        payload = {
          eventId: event.id,
          parentId,
          title,
          description: text(req.body.description),
          ...dates,
          status: status(req.body.status, "todo")
        };
      }
    } else if (type === "knowledge_document_create" || type === "knowledge_document_update") {
      const title = text(req.body.title);
      if (!title) {
        throw httpError(400, "Knowledge document title is required.");
      }
      const categoryId = normalizeKnowledgeCategoryId(db, req.params.projectId, req.body.categoryId);
      if (type === "knowledge_document_update") {
        const document = knowledgeDocument(db, req.params.projectId, req.body.documentId);
        if (!document) {
          throw httpError(404, "Knowledge document not found.");
        }
        targetId = document.id;
        payload = {
          documentId: document.id,
          title,
          content: markdownText(req.body.content, document.content),
          categoryId
        };
      } else {
        payload = {
          title,
          content: markdownText(req.body.content),
          categoryId
        };
      }
    } else {
      throw httpError(400, "Invalid request type.");
    }

    if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) {
      throw httpError(400, "End date must be after start date.");
    }

    const requestId = id();
    const current = now();
    await db.run(
      `INSERT INTO change_requests
       (id, project_id, requester_id, type, target_id, payload, status, reviewer_id, review_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, '', ?, ?)`,
      [requestId, req.params.projectId, req.user.id, type, targetId, JSON.stringify(payload), current, current]
    );
    broadcastProject(req.params.projectId, "request:created");
    res.status(201).json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/requests/:requestId/approve", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const request = db.get("SELECT * FROM change_requests WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.requestId]);
    if (!request || request.status !== "pending") {
      throw httpError(404, "Pending request not found.");
    }
    const payload = JSON.parse(request.payload);
    const current = now();

    if (request.type === "assignment_update") {
      const assignment = projectAssignment(db, req.params.projectId, payload.assignmentId);
      if (!assignment) {
        throw httpError(404, "Assignment not found.");
      }
      await db.run(
        "UPDATE assignments SET start_date = ?, end_date = ?, status = ?, updated_at = ? WHERE id = ?",
        [payload.startDate, payload.endDate, payload.status, current, assignment.id]
      );
      await syncTeamPersonalEvent(db, assignment.id);
      broadcastUser(assignment.user_id, "request:approved");
    } else if (request.type === "personal_to_team_assignment") {
      if (!projectTask(db, req.params.projectId, payload.taskId)) {
        throw httpError(404, "Task not found.");
      }
      const assignmentId = id();
      await db.run(
        `INSERT INTO assignments
         (id, project_id, task_id, user_id, start_date, end_date, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [assignmentId, req.params.projectId, payload.taskId, request.requester_id, payload.startDate, payload.endDate, payload.status, req.user.id, current, current]
      );
      await syncTeamPersonalEvent(db, assignmentId);
      broadcastUser(request.requester_id, "request:approved");
    } else if (request.type === "personal_to_team_task") {
      const position = db.get("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM tasks WHERE project_id = ?", [req.params.projectId]).next;
      const taskId = id();
      await db.run(
        `INSERT INTO tasks
         (id, project_id, parent_id, title, description, status, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, req.params.projectId, payload.parentId || null, payload.title, payload.description || "", payload.status, position, req.user.id, current, current]
      );
      const assignmentId = id();
      await db.run(
        `INSERT INTO assignments
         (id, project_id, task_id, user_id, start_date, end_date, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [assignmentId, req.params.projectId, taskId, request.requester_id, payload.startDate, payload.endDate, payload.status, req.user.id, current, current]
      );
      await syncTeamPersonalEvent(db, assignmentId);
      broadcastUser(request.requester_id, "request:approved");
    } else if (request.type === "knowledge_document_create") {
      await createKnowledgeDocument(db, req.params.projectId, req.user.id, payload, request.requester_id, false);
      broadcastUser(request.requester_id, "request:approved");
    } else if (request.type === "knowledge_document_update") {
      await updateKnowledgeDocument(db, req.params.projectId, payload.documentId, req.user.id, payload, false);
      broadcastUser(request.requester_id, "request:approved");
    }

    await db.run(
      "UPDATE change_requests SET status = 'approved', reviewer_id = ?, review_note = ?, updated_at = ? WHERE id = ?",
      [req.user.id, text(req.body.note), current, req.params.requestId]
    );
    broadcastProject(req.params.projectId, "request:approved");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.post("/api/projects/:projectId/requests/:requestId/reject", asyncRoute(async (req, res) => {
    requireAdmin(db, req.params.projectId, req.user.id);
    const request = db.get("SELECT * FROM change_requests WHERE project_id = ? AND id = ?", [req.params.projectId, req.params.requestId]);
    if (!request || request.status !== "pending") {
      throw httpError(404, "Pending request not found.");
    }
    await db.run(
      "UPDATE change_requests SET status = 'rejected', reviewer_id = ?, review_note = ?, updated_at = ? WHERE id = ?",
      [req.user.id, text(req.body.note), now(), req.params.requestId]
    );
    broadcastProject(req.params.projectId, "request:rejected");
    broadcastUser(request.requester_id, "request:rejected");
    res.json(toProjectState(db, req.params.projectId, req.user.id));
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: statusCode === 500 ? "Internal server error." : error.message
    });
  });

  return app;
}
