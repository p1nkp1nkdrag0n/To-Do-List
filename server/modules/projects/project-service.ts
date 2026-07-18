import { createHash } from "node:crypto";

import type {
  AddProjectMemberRequest,
  CreateProjectRequest,
  PatchProjectRequest,
} from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import { requireTeamMembership } from "../team/team-service.js";

const MEMBER_COLORS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#ca8a04",
  "#0891b2",
  "#9333ea",
  "#db2777",
  "#4f46e5",
] as const;

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface ProjectMemberRow extends Record<string, unknown> {
  user_id: string;
  username: string;
  display_name: string;
  color: string;
  joined_at: string;
  removed_at: string | null;
  revision: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ProjectMember {
  userId: string;
  username: string;
  displayName: string;
  color: string;
  joinedAt: string;
  revision: number;
}

interface LatestProjectMembership extends ProjectMember {
  removedAt: string | null;
  state: "active" | "removed";
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toProjectMember(row: ProjectMemberRow): ProjectMember {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    joinedAt: row.joined_at,
    revision: row.revision,
  };
}

function toLatestProjectMembership(
  row: ProjectMemberRow,
): LatestProjectMembership {
  return {
    ...toProjectMember(row),
    removedAt: row.removed_at,
    state: row.removed_at === null ? "active" : "removed",
  };
}

export function stableMemberColor(userId: string): string {
  const bucket = Number.parseInt(createHash("sha256").update(userId).digest("hex").slice(0, 8), 16);
  return MEMBER_COLORS[bucket % MEMBER_COLORS.length]!;
}

export class ProjectService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  list(auth: AuthenticatedSession): Project[] {
    return this.dependencies.database
      .all<ProjectRow>(
        `SELECT projects.id, projects.name, projects.description, projects.timezone,
                projects.start_date, projects.end_date, projects.created_at,
                projects.updated_at, projects.revision
           FROM projects
           JOIN project_members ON project_members.project_id = projects.id
          WHERE project_members.user_id = ?
            AND project_members.removed_at IS NULL
            AND projects.deleted_at IS NULL
            AND projects.archived_at IS NULL
          ORDER BY projects.updated_at DESC, projects.name COLLATE NOCASE`,
        [auth.user.id],
      )
      .map(toProject);
  }

  detail(auth: AuthenticatedSession, projectId: string): {
    project: Project;
    members: ProjectMember[];
  } {
    return {
      project: toProject(this.requireProjectMember(auth, projectId)),
      members: this.members(projectId),
    };
  }

  create(auth: AuthenticatedSession, input: CreateProjectRequest): {
    project: Project;
    members: ProjectMember[];
  } {
    requireTeamMembership(auth);
    const userIds = [...new Set([auth.user.id, ...input.memberUserIds])];
    const placeholders = userIds.map(() => "?").join(", ");
    const activeTeamIds = new Set(
      this.dependencies.database
        .all<{ id: string }>(
          `SELECT users.id
             FROM users
             JOIN team_members ON team_members.user_id = users.id
            WHERE users.disabled_at IS NULL
              AND team_members.removed_at IS NULL
              AND users.id IN (${placeholders})`,
          userIds,
        )
        .map(({ id }) => id),
    );
    if (activeTeamIds.size !== userIds.length) {
      throw new HttpError(
        400,
        "PROJECT_MEMBERS_INVALID",
        "Every project member must be an active team member.",
        { fieldErrors: { memberUserIds: ["Every selected user must be an active team member."] } },
      );
    }

    const projectId = this.dependencies.idGenerator();
    const now = this.dependencies.clock().toISOString();
    this.dependencies.database.transaction(() => {
      this.dependencies.database.run(
        `INSERT INTO projects
          (id, name, description, start_date, end_date, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          input.name,
          input.description ?? "",
          input.startDate ?? null,
          input.endDate ?? null,
          auth.user.id,
          auth.user.id,
          now,
          now,
        ],
      );
      for (const userId of userIds) {
        this.dependencies.database.run(
          `INSERT INTO project_members
            (project_id, user_id, color, joined_at, added_by)
           VALUES (?, ?, ?, ?, ?)`,
          [projectId, userId, stableMemberColor(userId), now, auth.user.id],
        );
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.created",
      });
    });
    return this.detail(auth, projectId);
  }

  update(
    auth: AuthenticatedSession,
    projectId: string,
    input: PatchProjectRequest,
  ): Project {
    const current = this.requireProjectMember(auth, projectId);
    if (current.revision !== input.expectedRevision) {
      throw this.revisionConflict(current);
    }
    const next = {
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      startDate: input.startDate === undefined ? current.start_date : input.startDate,
      endDate: input.endDate === undefined ? current.end_date : input.endDate,
    };
    if (next.startDate !== null && next.endDate !== null && next.startDate > next.endDate) {
      throw new HttpError(
        400,
        "PROJECT_DATE_RANGE_INVALID",
        "The project start date must not be after the end date.",
        { fieldErrors: { startDate: ["Start date must not be after end date."] } },
      );
    }

    const now = this.dependencies.clock().toISOString();
    this.dependencies.database.transaction(() => {
      const result = this.dependencies.database.run(
        `UPDATE projects
            SET name = ?, description = ?, start_date = ?, end_date = ?,
                updated_by = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [
          next.name,
          next.description,
          next.startDate,
          next.endDate,
          auth.user.id,
          now,
          projectId,
          input.expectedRevision,
        ],
      );
      if (result.changes !== 1) {
        const latest = this.projectRow(projectId);
        throw latest === undefined
          ? new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.")
          : this.revisionConflict(latest);
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.updated",
      });
    });
    return toProject(this.projectRow(projectId)!);
  }

  addMember(
    auth: AuthenticatedSession,
    projectId: string,
    input: AddProjectMemberRequest,
  ): { member: ProjectMember; added: boolean } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const teamUser = this.dependencies.database.get<{ id: string }>(
        `SELECT users.id
           FROM users
           JOIN team_members ON team_members.user_id = users.id
          WHERE users.id = ?
            AND users.disabled_at IS NULL
            AND team_members.removed_at IS NULL`,
        [input.userId],
      );
      if (teamUser === undefined) {
        throw new HttpError(
          409,
          "USER_NOT_TEAM_MEMBER",
          "The user must be an active team member first.",
        );
      }
      const existing = this.memberRow(projectId, input.userId);
      if (existing?.removed_at === null) {
        return { member: toProjectMember(existing), added: false };
      }

      const now = this.dependencies.clock().toISOString();
      if (existing === undefined) {
        this.dependencies.database.run(
          `INSERT INTO project_members
            (project_id, user_id, color, joined_at, added_by)
           VALUES (?, ?, ?, ?, ?)`,
          [
            projectId,
            input.userId,
            stableMemberColor(input.userId),
            now,
            auth.user.id,
          ],
        );
      } else {
        const reactivated = this.dependencies.database.run(
          `UPDATE project_members
              SET color = ?, joined_at = ?, added_by = ?, removed_at = NULL,
                  removed_by = NULL, revision = revision + 1
            WHERE project_id = ? AND user_id = ?
              AND revision = ? AND removed_at IS NOT NULL`,
          [
            stableMemberColor(input.userId),
            now,
            auth.user.id,
            projectId,
            input.userId,
            existing.revision,
          ],
        );
        if (reactivated.changes !== 1) {
          throw this.membershipConflict(
            this.memberRow(projectId, input.userId)!,
          );
        }
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_member",
        entityId: input.userId,
        action: "project.member_added",
      });
      return {
        member: toProjectMember(this.memberRow(projectId, input.userId)!),
        added: true,
      };
    });
  }

  removeMember(
    auth: AuthenticatedSession,
    projectId: string,
    userId: string,
    expectedRevision: number,
  ): void {
    this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.memberRow(projectId, userId);
      if (current === undefined) {
        throw new HttpError(
          404,
          "PROJECT_MEMBER_NOT_FOUND",
          "The project member was not found.",
        );
      }
      if (
        current.removed_at !== null ||
        current.revision !== expectedRevision
      ) {
        throw this.membershipConflict(current);
      }
      const remainingUsableMembers =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM project_members
             JOIN users ON users.id = project_members.user_id
            WHERE project_members.project_id = ?
              AND project_members.user_id <> ?
              AND project_members.removed_at IS NULL
              AND users.disabled_at IS NULL`,
          [projectId, userId],
        )?.count ?? 0;
      if (remainingUsableMembers === 0) {
        throw new HttpError(
          409,
          "LAST_PROJECT_MEMBER",
          "The final project member cannot be removed.",
        );
      }
      const assigned =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM task_participants
            WHERE project_id = ? AND user_id = ?`,
          [projectId, userId],
        )?.count ?? 0;
      if (assigned > 0) {
        throw new HttpError(
          409,
          "PROJECT_MEMBER_REMOVAL_UNSAFE",
          "The project member has task responsibilities that must be reassigned first.",
        );
      }

      const now = this.dependencies.clock().toISOString();
      const removed = this.dependencies.database.run(
        `UPDATE project_members
            SET removed_at = ?, removed_by = ?, revision = revision + 1
          WHERE project_id = ? AND user_id = ?
            AND revision = ? AND removed_at IS NULL`,
        [now, auth.user.id, projectId, userId, expectedRevision],
      );
      if (removed.changes !== 1) {
        const latest = this.memberRow(projectId, userId);
        throw latest === undefined
          ? new HttpError(
              404,
              "PROJECT_MEMBER_NOT_FOUND",
              "The project member was not found.",
            )
          : this.membershipConflict(latest);
      }
      const activeInvites = this.dependencies.database.all<{ id: string }>(
        `SELECT id FROM project_invites
          WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        [projectId, now],
      );
      const revokedInvites = this.dependencies.database.run(
        `UPDATE project_invites
            SET revoked_at = ?, revoked_by = ?, revision = revision + 1
          WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        [now, auth.user.id, projectId, now],
      );
      if (revokedInvites.changes !== activeInvites.length) {
        throw new Error("The active project invite set changed while removing a member.");
      }
      for (const invite of activeInvites) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "project_invite",
          entityId: invite.id,
          action: "project_invite.revoked",
          metadata: { reason: "member_removed" },
        });
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_member",
        entityId: userId,
        action: "project.member_removed",
      });
    });
  }

  private requireProjectMember(auth: AuthenticatedSession, projectId: string): ProjectRow {
    const row = this.dependencies.database.get<ProjectRow>(
      `SELECT projects.id, projects.name, projects.description, projects.timezone,
              projects.start_date, projects.end_date, projects.created_at,
              projects.updated_at, projects.revision
         FROM projects
         JOIN project_members ON project_members.project_id = projects.id
        WHERE projects.id = ?
          AND project_members.user_id = ?
          AND project_members.removed_at IS NULL
          AND projects.deleted_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (row === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return row;
  }

  private projectRow(projectId: string): ProjectRow | undefined {
    return this.dependencies.database.get<ProjectRow>(
      `SELECT id, name, description, timezone, start_date, end_date,
              created_at, updated_at, revision
         FROM projects WHERE id = ? AND deleted_at IS NULL`,
      [projectId],
    );
  }

  private members(projectId: string): ProjectMember[] {
    return this.dependencies.database
      .all<ProjectMemberRow>(
        `SELECT project_members.user_id, users.username, users.display_name,
                project_members.color, project_members.joined_at,
                project_members.removed_at, project_members.revision
           FROM project_members
           JOIN users ON users.id = project_members.user_id
          WHERE project_members.project_id = ?
            AND project_members.removed_at IS NULL
          ORDER BY users.username COLLATE NOCASE`,
        [projectId],
      )
      .map(toProjectMember);
  }

  private memberRow(projectId: string, userId: string): ProjectMemberRow | undefined {
    return this.dependencies.database.get<ProjectMemberRow>(
      `SELECT project_members.user_id, users.username, users.display_name,
              project_members.color, project_members.joined_at,
              project_members.removed_at, project_members.revision
         FROM project_members
         JOIN users ON users.id = project_members.user_id
        WHERE project_members.project_id = ? AND project_members.user_id = ?`,
      [projectId, userId],
    );
  }

  private revisionConflict(latest: ProjectRow): HttpError {
    return new HttpError(
      409,
      "REVISION_CONFLICT",
      "The project changed on another client.",
      { latest: toProject(latest) },
    );
  }

  private membershipConflict(latest: ProjectMemberRow): HttpError {
    return new HttpError(
      409,
      "REVISION_CONFLICT",
      "The project membership changed on another client.",
      { latest: toLatestProjectMembership(latest) },
    );
  }
}
