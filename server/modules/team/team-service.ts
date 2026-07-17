import type { AddTeamMemberRequest } from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";

interface TeamMemberRow extends Record<string, unknown> {
  user_id: string;
  username: string;
  display_name: string;
  joined_at: string;
  removed_at: string | null;
  revision: number;
}

export interface TeamMember {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
  revision: number;
}

interface LatestTeamMembership extends TeamMember {
  removedAt: string | null;
  state: "active" | "removed";
}

function toTeamMember(row: TeamMemberRow): TeamMember {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    joinedAt: row.joined_at,
    revision: row.revision,
  };
}

function toLatestTeamMembership(row: TeamMemberRow): LatestTeamMembership {
  return {
    ...toTeamMember(row),
    removedAt: row.removed_at,
    state: row.removed_at === null ? "active" : "removed",
  };
}

export function requireTeamMembership(auth: AuthenticatedSession): void {
  if (!auth.teamMember) {
    throw new HttpError(
      403,
      "TEAM_MEMBERSHIP_REQUIRED",
      "Team membership is required.",
    );
  }
}

export class TeamService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  list(auth: AuthenticatedSession): TeamMember[] {
    requireTeamMembership(auth);
    this.requireActiveActor(auth.user.id);
    return this.dependencies.database
      .all<TeamMemberRow>(
        `SELECT team_members.user_id, users.username, users.display_name,
                team_members.joined_at, team_members.removed_at,
                team_members.revision
           FROM team_members
           JOIN users ON users.id = team_members.user_id
          WHERE users.disabled_at IS NULL AND team_members.removed_at IS NULL
          ORDER BY users.username COLLATE NOCASE`,
      )
      .map(toTeamMember);
  }

  add(
    auth: AuthenticatedSession,
    input: AddTeamMemberRequest,
  ): { member: TeamMember; added: boolean } {
    requireTeamMembership(auth);
    return this.dependencies.database.transaction(() => {
      this.requireActiveActor(auth.user.id);
      const user = input.userId !== undefined
        ? this.dependencies.database.get<{ id: string }>(
            "SELECT id FROM users WHERE id = ? AND disabled_at IS NULL",
            [input.userId],
          )
        : this.dependencies.database.get<{ id: string }>(
            "SELECT id FROM users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL",
            [input.username!],
          );
      if (user === undefined) {
        throw new HttpError(
          404,
          "USER_NOT_FOUND",
          "The registered user was not found.",
        );
      }

      const existing = this.memberRow(user.id);
      if (existing?.removed_at === null) {
        return { member: toTeamMember(existing), added: false };
      }

      const now = this.dependencies.clock().toISOString();
      if (existing === undefined) {
        this.dependencies.database.run(
          `INSERT INTO team_members (user_id, joined_at, invited_by)
           VALUES (?, ?, ?)`,
          [user.id, now, auth.user.id],
        );
      } else {
        const reactivated = this.dependencies.database.run(
          `UPDATE team_members
              SET joined_at = ?, invited_by = ?, removed_at = NULL,
                  removed_by = NULL, revision = revision + 1
            WHERE user_id = ? AND revision = ? AND removed_at IS NOT NULL`,
          [now, auth.user.id, user.id, existing.revision],
        );
        if (reactivated.changes !== 1) {
          throw this.membershipConflict(this.memberRow(user.id)!);
        }
      }
      writeActivity(this.dependencies, {
        actorId: auth.user.id,
        entityType: "team_member",
        entityId: user.id,
        action: "team.member_added",
      });
      return { member: toTeamMember(this.memberRow(user.id)!), added: true };
    });
  }

  remove(
    auth: AuthenticatedSession,
    userId: string,
    expectedRevision: number,
  ): void {
    requireTeamMembership(auth);
    this.dependencies.database.transaction(() => {
      this.requireActiveActor(auth.user.id);
      const current = this.memberRow(userId);
      if (current === undefined) {
        throw new HttpError(
          404,
          "TEAM_MEMBER_NOT_FOUND",
          "The team member was not found.",
        );
      }
      if (
        current.removed_at !== null ||
        current.revision !== expectedRevision
      ) {
        throw this.membershipConflict(current);
      }

      const remainingActive =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM team_members
             JOIN users ON users.id = team_members.user_id
            WHERE users.disabled_at IS NULL
              AND team_members.removed_at IS NULL
              AND team_members.user_id <> ?`,
          [userId],
        )?.count ?? 0;
      if (remainingActive === 0) {
        throw new HttpError(
          409,
          "LAST_TEAM_MEMBER",
          "The last active team member cannot be removed.",
        );
      }

      const projectMembershipCount =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM project_members
            WHERE user_id = ? AND removed_at IS NULL`,
          [userId],
        )?.count ?? 0;
      if (projectMembershipCount > 0) {
        const membershipLabel =
          projectMembershipCount === 1
            ? "project membership"
            : "project memberships";
        const objectPronoun = projectMembershipCount === 1 ? "it" : "them";
        throw new HttpError(
          409,
          "TEAM_MEMBER_HAS_PROJECTS",
          `The team member has ${projectMembershipCount} ${membershipLabel} and must be removed from ${objectPronoun} first.`,
        );
      }

      const taskAssignmentCount =
        this.dependencies.database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM task_participants WHERE user_id = ?",
          [userId],
        )?.count ?? 0;
      if (taskAssignmentCount > 0) {
        throw new HttpError(
          409,
          "TEAM_MEMBER_REMOVAL_UNSAFE",
          "The team member has task responsibilities that must be reassigned first.",
        );
      }

      const now = this.dependencies.clock().toISOString();
      const removed = this.dependencies.database.run(
        `UPDATE team_members
            SET removed_at = ?, removed_by = ?, revision = revision + 1
          WHERE user_id = ? AND revision = ? AND removed_at IS NULL`,
        [now, auth.user.id, userId, expectedRevision],
      );
      if (removed.changes !== 1) {
        const latest = this.memberRow(userId);
        throw latest === undefined
          ? new HttpError(
              404,
              "TEAM_MEMBER_NOT_FOUND",
              "The team member was not found.",
            )
          : this.membershipConflict(latest);
      }
      writeActivity(this.dependencies, {
        actorId: auth.user.id,
        entityType: "team_member",
        entityId: userId,
        action: "team.member_removed",
      });
    });
  }

  private requireActiveActor(userId: string): void {
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

  private memberRow(userId: string): TeamMemberRow | undefined {
    return this.dependencies.database.get<TeamMemberRow>(
      `SELECT team_members.user_id, users.username, users.display_name,
              team_members.joined_at, team_members.removed_at,
              team_members.revision
         FROM team_members
         JOIN users ON users.id = team_members.user_id
        WHERE team_members.user_id = ?`,
      [userId],
    );
  }

  private membershipConflict(latest: TeamMemberRow): HttpError {
    return new HttpError(
      409,
      "REVISION_CONFLICT",
      "The team membership changed on another client.",
      { latest: toLatestTeamMembership(latest) },
    );
  }
}
