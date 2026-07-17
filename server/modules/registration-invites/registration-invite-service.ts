import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import { registrationInviteDigest } from "./registration-invite-crypto.js";

export const REGISTRATION_INVITE_DURATION_MS = 24 * 60 * 60 * 1000;

interface RegistrationInviteRow extends Record<string, unknown> {
  id: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
  revision: number;
}

export interface CreatedRegistrationInvite {
  id: string;
  code: string;
  expiresAt: string;
  revision: number;
}

export interface PublicRegistrationInvite {
  id: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revision: number;
  state: "active" | "used" | "revoked" | "expired";
}

function publicInvite(
  row: RegistrationInviteRow,
  now: string,
): PublicRegistrationInvite {
  const state = row.revoked_at !== null
    ? "revoked"
    : row.used_at !== null
      ? "used"
      : row.expires_at <= now
        ? "expired"
        : "active";
  return {
    id: row.id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    revision: row.revision,
    state,
  };
}

export class RegistrationInviteService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  create(actorId: string): CreatedRegistrationInvite {
    return this.dependencies.database.transaction(() => {
      this.requireActiveTeamMember(actorId);
      const now = this.dependencies.clock();
      const nowIso = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + REGISTRATION_INVITE_DURATION_MS,
      ).toISOString();
      const { code, digest } = this.generateUnusedCode();
      const inviteId = this.dependencies.idGenerator();
      this.dependencies.database.run(
        `INSERT INTO registration_invites
          (id, code_hash, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [inviteId, digest, expiresAt, actorId, nowIso],
      );
      writeActivity(this.dependencies, {
        actorId,
        entityType: "registration_invite",
        entityId: inviteId,
        action: "registration_invite.created",
        metadata: { expiresAt },
      });
      return { id: inviteId, code, expiresAt, revision: 1 };
    });
  }

  revoke(actorId: string, inviteId: string, expectedRevision: number): void {
    this.dependencies.database.transaction(() => {
      this.requireActiveTeamMember(actorId);
      const now = this.dependencies.clock().toISOString();
      const current = this.findInvite(inviteId);
      if (current === undefined) {
        throw new HttpError(
          404,
          "REGISTRATION_INVITE_NOT_FOUND",
          "The registration invite was not found.",
        );
      }

      const updated = this.dependencies.database.run(
        `UPDATE registration_invites
            SET revoked_at = ?, revoked_by = ?, revision = revision + 1
          WHERE id = ?
            AND revision = ?
            AND used_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ?`,
        [now, actorId, inviteId, expectedRevision, now],
      );
      if (updated.changes !== 1) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "The registration invite changed on another client.",
          { latest: publicInvite(current, now) },
        );
      }
      writeActivity(this.dependencies, {
        actorId,
        entityType: "registration_invite",
        entityId: inviteId,
        action: "registration_invite.revoked",
      });
    });
  }

  private requireActiveTeamMember(userId: string): void {
    const member = this.dependencies.database.get<{ user_id: string }>(
      `SELECT team_members.user_id
         FROM team_members
         JOIN users ON users.id = team_members.user_id
        WHERE team_members.user_id = ?
          AND team_members.removed_at IS NULL
          AND users.disabled_at IS NULL`,
      [userId],
    );
    if (member === undefined) {
      throw new HttpError(
        403,
        "TEAM_MEMBERSHIP_REQUIRED",
        "Team membership is required.",
      );
    }
  }

  private findInvite(inviteId: string): RegistrationInviteRow | undefined {
    return this.dependencies.database.get<RegistrationInviteRow>(
      `SELECT id, expires_at, created_at, used_at, revoked_at, revision
         FROM registration_invites WHERE id = ?`,
      [inviteId],
    );
  }

  private generateUnusedCode(): { code: string; digest: string } {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = this.dependencies.registrationInviteCodeGenerator();
      if (code.length === 0) {
        throw new Error(
          "The registration invite code generator returned an empty code.",
        );
      }
      const digest = registrationInviteDigest(code);
      const existing = this.dependencies.database.get<{ id: string }>(
        "SELECT id FROM registration_invites WHERE code_hash = ?",
        [digest],
      );
      if (existing === undefined) {
        return { code, digest };
      }
    }
    throw new HttpError(
      503,
      "REGISTRATION_INVITE_CODE_UNAVAILABLE",
      "A unique registration invite code could not be generated.",
    );
  }
}
