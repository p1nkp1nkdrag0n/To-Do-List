import type { ProjectInviteRedeemRequest } from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import { ATTEMPT_RETENTION_MS } from "../attempt-housekeeping.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import { stableMemberColor } from "../projects/project-service.js";
import {
  isSixDigitProjectCode,
  projectInviteDigest,
} from "./invite-crypto.js";

const INVITE_DURATION_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_FAILURES = 5;

interface ProjectInviteRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  expires_at: string;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
  revision: number;
}

export interface CreatedProjectInvite {
  id: string;
  projectId: string;
  code: string;
  expiresAt: string;
  revision: number;
}

export interface ProjectInviteRedemption {
  projectId: string;
  teamMember: true;
  projectMember: true;
  addedToTeam: boolean;
  addedToProject: boolean;
}

export interface PublicProjectInvite {
  id: string;
  projectId: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  revision: number;
  state: "active" | "revoked" | "expired";
}

function publicProjectInvite(
  row: ProjectInviteRow,
  now: string,
): PublicProjectInvite {
  return {
    id: row.id,
    projectId: row.project_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revision: row.revision,
    state:
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at <= now
          ? "expired"
          : "active",
  };
}

type RedemptionDecision =
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | ({ kind: "success" } & ProjectInviteRedemption);

export class ProjectInviteService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  create(auth: AuthenticatedSession, projectId: string): CreatedProjectInvite {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const { code, digest } = this.generateUnusedCode();
      const inviteId = this.dependencies.idGenerator();
      const now = this.dependencies.clock();
      const expiresAt = new Date(
        now.getTime() + INVITE_DURATION_MS,
      ).toISOString();
      const superseded = this.dependencies.database.all<{ id: string }>(
        `SELECT id FROM project_invites
          WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        [projectId, now.toISOString()],
      );
      this.dependencies.database.run(
        `UPDATE project_invites
            SET revoked_at = ?, revoked_by = ?, revision = revision + 1
          WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        [now.toISOString(), auth.user.id, projectId, now.toISOString()],
      );
      for (const invite of superseded) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "project_invite",
          entityId: invite.id,
          action: "project_invite.revoked",
          metadata: { reason: "superseded" },
        });
      }
      this.dependencies.database.run(
        `INSERT INTO project_invites
          (id, project_id, code_hash, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [inviteId, projectId, digest, expiresAt, auth.user.id, now.toISOString()],
      );
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_invite",
        entityId: inviteId,
        action: "project_invite.generated",
        metadata: { expiresAt },
      });
      return { id: inviteId, projectId, code, expiresAt, revision: 1 };
    });
  }

  revoke(
    auth: AuthenticatedSession,
    projectId: string,
    inviteId: string,
    expectedRevision: number,
  ): void {
    this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const now = this.dependencies.clock().toISOString();
      const current = this.findProjectInvite(projectId, inviteId);
      if (current === undefined) {
        throw new HttpError(
          404,
          "PROJECT_INVITE_NOT_FOUND",
          "The project invite was not found.",
        );
      }

      const updated = this.dependencies.database.run(
        `UPDATE project_invites
            SET revoked_at = ?, revoked_by = ?, revision = revision + 1
          WHERE id = ?
            AND project_id = ?
            AND revision = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
        [now, auth.user.id, inviteId, projectId, expectedRevision, now],
      );
      if (updated.changes !== 1) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "The project invite changed on another client.",
          {
            latest: publicProjectInvite(current, now),
          },
        );
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_invite",
        entityId: inviteId,
        action: "project_invite.revoked",
      });
    });
  }

  redeem(
    auth: AuthenticatedSession,
    input: ProjectInviteRedeemRequest,
    ipAddress: string,
  ): ProjectInviteRedemption {
    const digest = projectInviteDigest(this.dependencies.sessionSecret, input.code);
    const decision = this.dependencies.database.transaction<RedemptionDecision>(() => {
      const now = this.dependencies.clock();
      const nowIso = now.toISOString();
      this.dependencies.database.run(
        "DELETE FROM project_invite_attempts WHERE attempted_at < ?",
        [new Date(now.getTime() - ATTEMPT_RETENTION_MS).toISOString()],
      );
      const cutoff = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS).toISOString();
      const accountFailures =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM project_invite_attempts
            WHERE user_id = ? AND succeeded = 0 AND attempted_at >= ?`,
          [auth.user.id, cutoff],
        )?.count ?? 0;
      const ipFailures =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM project_invite_attempts
            WHERE ip_address = ? AND succeeded = 0 AND attempted_at >= ?`,
          [ipAddress, cutoff],
        )?.count ?? 0;
      if (
        accountFailures >= RATE_LIMIT_FAILURES ||
        ipFailures >= RATE_LIMIT_FAILURES
      ) {
        return { kind: "rate_limited" };
      }

      const invite = this.dependencies.database.get<ProjectInviteRow>(
        `SELECT project_invites.id, project_invites.project_id,
                project_invites.expires_at, project_invites.created_at,
                project_invites.created_by,
                project_invites.revoked_at, project_invites.revision
           FROM project_invites
           JOIN projects ON projects.id = project_invites.project_id
           JOIN project_members AS creator_members
             ON creator_members.project_id = project_invites.project_id
            AND creator_members.user_id = project_invites.created_by
            AND creator_members.removed_at IS NULL
           JOIN users AS creator_users
             ON creator_users.id = project_invites.created_by
            AND creator_users.disabled_at IS NULL
          WHERE project_invites.code_hash = ? AND projects.deleted_at IS NULL`,
        [digest],
      );
      if (
        invite === undefined ||
        invite.revoked_at !== null ||
        invite.expires_at <= nowIso
      ) {
        this.recordAttempt({
          inviteId: invite?.id ?? null,
          digest,
          userId: auth.user.id,
          ipAddress,
          succeeded: false,
          attemptedAt: nowIso,
        });
        return { kind: "invalid" };
      }

      this.recordAttempt({
        inviteId: invite.id,
        digest,
        userId: auth.user.id,
        ipAddress,
        succeeded: true,
        attemptedAt: nowIso,
      });
      const teamInsert = this.dependencies.database.run(
        `INSERT INTO team_members (user_id, joined_at, invited_by)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           joined_at = excluded.joined_at,
           invited_by = excluded.invited_by,
           removed_at = NULL,
           removed_by = NULL,
           revision = team_members.revision + 1
         WHERE team_members.removed_at IS NOT NULL`,
        [auth.user.id, nowIso, invite.created_by],
      );
      const addedToTeam = teamInsert.changes === 1;
      const projectInsert = this.dependencies.database.run(
        `INSERT INTO project_members
          (project_id, user_id, color, joined_at, added_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET
           color = excluded.color,
           joined_at = excluded.joined_at,
           added_by = excluded.added_by,
           removed_at = NULL,
           removed_by = NULL,
           revision = project_members.revision + 1
         WHERE project_members.removed_at IS NOT NULL`,
        [
          invite.project_id,
          auth.user.id,
          stableMemberColor(auth.user.id),
          nowIso,
          invite.created_by,
        ],
      );
      const addedToProject = projectInsert.changes === 1;
      writeActivity(this.dependencies, {
        projectId: invite.project_id,
        actorId: auth.user.id,
        entityType: "project_invite",
        entityId: invite.id,
        action: "project_invite.redeemed",
        metadata: { addedToTeam, addedToProject },
      });
      return {
        kind: "success",
        projectId: invite.project_id,
        teamMember: true,
        projectMember: true,
        addedToTeam,
        addedToProject,
      };
    });

    if (decision.kind === "rate_limited") {
      throw new HttpError(
        429,
        "PROJECT_INVITE_RATE_LIMITED",
        "Too many failed project invite attempts. Try again later.",
      );
    }
    if (decision.kind === "invalid") {
      throw new HttpError(
        400,
        "PROJECT_INVITE_INVALID",
        "The project invite code is invalid or unavailable.",
      );
    }
    const { kind: _kind, ...redemption } = decision;
    return redemption;
  }

  private generateUnusedCode(): { code: string; digest: string } {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = this.dependencies.projectInviteCodeGenerator();
      if (!isSixDigitProjectCode(code)) {
        throw new Error("The project invite code generator must return exactly six digits.");
      }
      const digest = projectInviteDigest(this.dependencies.sessionSecret, code);
      const existing = this.dependencies.database.get<{ id: string }>(
        "SELECT id FROM project_invites WHERE code_hash = ?",
        [digest],
      );
      if (existing === undefined) {
        return { code, digest };
      }
    }
    throw new HttpError(
      503,
      "PROJECT_INVITE_CODE_UNAVAILABLE",
      "A unique project invite code could not be generated.",
    );
  }

  private requireProjectMember(auth: AuthenticatedSession, projectId: string): void {
    const membership = this.dependencies.database.get<{ project_id: string }>(
      `SELECT projects.id AS project_id
         FROM projects
         JOIN project_members ON project_members.project_id = projects.id
        WHERE projects.id = ?
          AND project_members.user_id = ?
          AND project_members.removed_at IS NULL
          AND projects.deleted_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (membership === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
  }

  private findProjectInvite(
    projectId: string,
    inviteId: string,
  ): ProjectInviteRow | undefined {
    return this.dependencies.database.get<ProjectInviteRow>(
      `SELECT id, project_id, expires_at, created_at, created_by,
              revoked_at, revision
         FROM project_invites
        WHERE id = ? AND project_id = ?`,
      [inviteId, projectId],
    );
  }

  private recordAttempt(input: {
    inviteId: string | null;
    digest: string;
    userId: string;
    ipAddress: string;
    succeeded: boolean;
    attemptedAt: string;
  }): void {
    this.dependencies.database.run(
      `INSERT INTO project_invite_attempts
        (id, project_invite_id, attempted_code_hash, user_id, ip_address,
         succeeded, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        this.dependencies.idGenerator(),
        input.inviteId,
        input.digest,
        input.userId,
        input.ipAddress,
        input.succeeded ? 1 : 0,
        input.attemptedAt,
      ],
    );
  }
}
