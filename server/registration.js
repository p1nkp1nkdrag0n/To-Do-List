import crypto from "node:crypto";

const codePrefix = "registration-code:";

function now() {
  return new Date().toISOString();
}

export function createPlainRegistrationCode() {
  return crypto.randomBytes(24).toString("base64url");
}

export function normalizeRegistrationCode(value) {
  return String(value || "").trim();
}

export function hashRegistrationCode(code) {
  return crypto.createHash("sha256").update(`${codePrefix}${normalizeRegistrationCode(code)}`).digest("hex");
}

export function timingSafeCodeEqual(value, expected) {
  if (!value || !expected) {
    return false;
  }
  const valueHash = hashRegistrationCode(value);
  const expectedHash = hashRegistrationCode(expected);
  return crypto.timingSafeEqual(Buffer.from(valueHash), Buffer.from(expectedHash));
}

export function userCount(db) {
  return Number(db.get("SELECT COUNT(*) AS count FROM users").count || 0);
}

export async function createRegistrationInvite(db, { code = createPlainRegistrationCode() } = {}) {
  const invite = {
    id: crypto.randomUUID(),
    code: normalizeRegistrationCode(code),
    codeHash: hashRegistrationCode(code),
    createdAt: now()
  };
  await db.run(
    "INSERT INTO registration_invites (id, code_hash, created_at) VALUES (?, ?, ?)",
    [invite.id, invite.codeHash, invite.createdAt]
  );
  return invite;
}

export function resolveRegistrationCode(db, registrationCode) {
  const code = normalizeRegistrationCode(registrationCode);
  if (!code) {
    return { ok: false, reason: "missing" };
  }

  if (userCount(db) === 0) {
    return timingSafeCodeEqual(code, process.env.BOOTSTRAP_CODE)
      ? { ok: true, type: "bootstrap" }
      : { ok: false, reason: process.env.BOOTSTRAP_CODE ? "invalid" : "bootstrap_unconfigured" };
  }

  const codeHash = hashRegistrationCode(code);
  const invite = db.get(
    "SELECT id, used_at AS usedAt FROM registration_invites WHERE code_hash = ?",
    [codeHash]
  );
  if (!invite || invite.usedAt) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, type: "invite", inviteId: invite.id };
}

export async function markInviteUsed(db, inviteId) {
  if (!inviteId) {
    return true;
  }
  const changed = await db.run(
    "UPDATE registration_invites SET used_at = ? WHERE id = ? AND used_at IS NULL",
    [now(), inviteId]
  );
  return changed === 1;
}

export async function markInviteUser(db, inviteId, userId) {
  if (!inviteId) {
    return;
  }
  await db.run(
    "UPDATE registration_invites SET used_by = ? WHERE id = ?",
    [userId, inviteId]
  );
}
