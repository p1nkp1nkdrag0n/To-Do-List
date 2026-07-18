import type {
  AvailabilityDocument,
  ProjectAvailabilitySummary,
  PutAvailabilityRequest,
  ScheduleConflict,
} from "../../../shared/availability-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import { computeAvailabilityConflicts } from "./conflict-engine.js";

interface AvailabilityProfileRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  valid_from: string;
  valid_through: string;
  weekly_capacity_minutes: number;
  private_note: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface AvailabilitySlotRow extends Record<string, unknown> {
  profile_id: string;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
}

interface AvailabilityExceptionRow extends Record<string, unknown> {
  profile_id: string;
  exception_date: string;
  kind: "available" | "unavailable";
  start_minute: number;
  end_minute: number;
  private_note: string;
}

interface ProjectMemberRow extends Record<string, unknown> {
  user_id: string;
  username: string;
  display_name: string;
  color: string;
}

interface ConflictTaskRow extends Record<string, unknown> {
  id: string;
  start_date: string | null;
  due_date: string | null;
}

interface ConflictParticipantRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  estimated_minutes: number;
  progress_percent: number;
}

interface ConflictDependencyRow extends Record<string, unknown> {
  id: string;
  predecessor_task_id: string;
  successor_task_id: string;
}

function todayInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export class AvailabilityService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  getDocument(auth: AuthenticatedSession): AvailabilityDocument {
    return this.documentForUser(auth.user.id);
  }

  replaceDocument(
    auth: AuthenticatedSession,
    input: PutAvailabilityRequest,
  ): AvailabilityDocument {
    return this.dependencies.database.transaction(() => {
      const current = this.dependencies.database.get<{
        availability_revision: number;
      }>("SELECT availability_revision FROM users WHERE id=?", [auth.user.id]);
      if (current === undefined) {
        throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required.");
      }
      if (current.availability_revision !== input.expectedRevision) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "Availability changed on another client.",
          { latest: this.documentForUser(auth.user.id) },
        );
      }

      const existing = new Map(
        this.profileRows([auth.user.id]).map((profile) => [profile.id, profile]),
      );
      for (const profile of input.profiles) {
        if (profile.id !== undefined && !existing.has(profile.id)) {
          throw new HttpError(
            400,
            "AVAILABILITY_PROFILE_INVALID",
            "An availability profile ID does not belong to the current user.",
            { fieldErrors: { profiles: ["Reload availability before saving."] } },
          );
        }
      }

      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run(
        "DELETE FROM availability_profiles WHERE user_id=?",
        [auth.user.id],
      );
      for (const profile of input.profiles) {
        const previous = profile.id === undefined ? undefined : existing.get(profile.id);
        const profileId = previous?.id ?? this.dependencies.idGenerator();
        this.dependencies.database.run(
          `INSERT INTO availability_profiles
            (id, user_id, valid_from, valid_through, weekly_capacity_minutes,
             private_note, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            profileId,
            auth.user.id,
            profile.validFrom,
            profile.validThrough,
            profile.weeklyCapacityMinutes,
            profile.privateNote,
            previous?.created_at ?? now,
            now,
            previous === undefined ? 1 : previous.revision + 1,
          ],
        );
        for (const slot of profile.weeklySlots) {
          this.dependencies.database.run(
            `INSERT INTO availability_slots
              (id, profile_id, day_of_week, start_minute, end_minute,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              this.dependencies.idGenerator(),
              profileId,
              slot.dayOfWeek,
              slot.startMinute,
              slot.endMinute,
              now,
              now,
            ],
          );
        }
        for (const exception of profile.exceptions) {
          this.dependencies.database.run(
            `INSERT INTO availability_exceptions
              (id, profile_id, exception_date, kind, start_minute, end_minute,
               private_note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              this.dependencies.idGenerator(),
              profileId,
              exception.exceptionDate,
              exception.kind,
              exception.startMinute,
              exception.endMinute,
              exception.privateNote,
              now,
              now,
            ],
          );
        }
      }

      const changed = this.dependencies.database.run(
        `UPDATE users
            SET availability_revision=availability_revision+1
          WHERE id=? AND availability_revision=?`,
        [auth.user.id, input.expectedRevision],
      );
      if (changed.changes !== 1) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "Availability changed on another client.",
          { latest: this.documentForUser(auth.user.id) },
        );
      }
      writeActivity(this.dependencies, {
        actorId: auth.user.id,
        entityType: "availability",
        entityId: auth.user.id,
        action: "availability.updated",
        metadata: { profileCount: input.profiles.length },
      });
      return this.documentForUser(auth.user.id);
    });
  }

  projectSummary(
    auth: AuthenticatedSession,
    projectId: string,
  ): ProjectAvailabilitySummary {
    this.requireProjectMember(auth.user.id, projectId);
    const members = this.projectMembers(projectId);
    const profilesByUser = this.profilesByUser(members.map(({ user_id }) => user_id));
    return {
      projectId,
      members: members.map((member) => ({
        userId: member.user_id,
        username: member.username,
        displayName: member.display_name,
        color: member.color,
        profiles: (profilesByUser.get(member.user_id) ?? []).map((profile) => ({
          validFrom: profile.validFrom,
          validThrough: profile.validThrough,
          weeklyCapacityMinutes: profile.weeklyCapacityMinutes,
          weeklySlots: profile.weeklySlots,
          exceptions: profile.exceptions.map(({ privateNote: _privateNote, ...exception }) => exception),
        })),
      })),
    };
  }

  projectConflicts(projectId: string): ScheduleConflict[] {
    const project = this.dependencies.database.get<{ timezone: string }>(
      "SELECT timezone FROM projects WHERE id=? AND deleted_at IS NULL",
      [projectId],
    );
    if (project === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    const tasks = this.dependencies.database.all<ConflictTaskRow>(
      `SELECT id, start_date, due_date FROM tasks
        WHERE project_id=? AND archived_at IS NULL AND deleted_at IS NULL`,
      [projectId],
    );
    const participants = this.dependencies.database.all<ConflictParticipantRow>(
      `SELECT task_participants.id, task_participants.task_id,
              task_participants.user_id, task_participants.start_date,
              task_participants.end_date, task_participants.estimated_minutes,
              task_participants.progress_percent
         FROM task_participants
         JOIN tasks ON tasks.id=task_participants.task_id
                   AND tasks.project_id=task_participants.project_id
        WHERE task_participants.project_id=?
          AND task_participants.removed_at IS NULL
          AND tasks.archived_at IS NULL AND tasks.deleted_at IS NULL`,
      [projectId],
    );
    const dependencies = this.dependencies.database.all<ConflictDependencyRow>(
      `SELECT id, predecessor_task_id, successor_task_id
         FROM task_dependencies
        WHERE project_id=? AND deleted_at IS NULL`,
      [projectId],
    );
    const profiles = [...this.profilesByUser(
      [...new Set(participants.map(({ user_id }) => user_id))],
    ).entries()].flatMap(([userId, userProfiles]) =>
      userProfiles.map((profile) => ({
        id: profile.id,
        userId,
        validFrom: profile.validFrom,
        validThrough: profile.validThrough,
        weeklyCapacityMinutes: profile.weeklyCapacityMinutes,
        weeklySlots: profile.weeklySlots,
        exceptions: profile.exceptions.map(
          ({ privateNote: _privateNote, ...exception }) => exception,
        ),
      })),
    );
    return computeAvailabilityConflicts({
      projectId,
      today: todayInTimeZone(this.dependencies.clock(), project.timezone),
      tasks: tasks.map((task) => ({
        id: task.id,
        startDate: task.start_date,
        dueDate: task.due_date,
      })),
      participants: participants.map((participant) => ({
        id: participant.id,
        taskId: participant.task_id,
        userId: participant.user_id,
        startDate: participant.start_date,
        endDate: participant.end_date,
        estimatedMinutes: participant.estimated_minutes,
        progressPercent: participant.progress_percent,
      })),
      dependencies: dependencies.map((dependency) => ({
        id: dependency.id,
        predecessorTaskId: dependency.predecessor_task_id,
        successorTaskId: dependency.successor_task_id,
      })),
      profiles,
    });
  }

  private documentForUser(userId: string): AvailabilityDocument {
    const user = this.dependencies.database.get<{ availability_revision: number }>(
      "SELECT availability_revision FROM users WHERE id=?",
      [userId],
    );
    if (user === undefined) {
      throw new HttpError(404, "USER_NOT_FOUND", "The user was not found.");
    }
    return {
      revision: user.availability_revision,
      profiles: this.profilesByUser([userId]).get(userId) ?? [],
    };
  }

  private profilesByUser(userIds: string[]): Map<string, AvailabilityDocument["profiles"]> {
    const result = new Map<string, AvailabilityDocument["profiles"]>();
    if (userIds.length === 0) return result;
    const profiles = this.profileRows(userIds);
    const profileIds = profiles.map(({ id }) => id);
    const slots = this.slotRows(profileIds);
    const exceptions = this.exceptionRows(profileIds);
    const slotsByProfile = new Map<string, AvailabilitySlotRow[]>();
    const exceptionsByProfile = new Map<string, AvailabilityExceptionRow[]>();
    for (const slot of slots) {
      const rows = slotsByProfile.get(slot.profile_id) ?? [];
      rows.push(slot);
      slotsByProfile.set(slot.profile_id, rows);
    }
    for (const exception of exceptions) {
      const rows = exceptionsByProfile.get(exception.profile_id) ?? [];
      rows.push(exception);
      exceptionsByProfile.set(exception.profile_id, rows);
    }
    for (const profile of profiles) {
      const values = result.get(profile.user_id) ?? [];
      values.push({
        id: profile.id,
        validFrom: profile.valid_from,
        validThrough: profile.valid_through,
        weeklyCapacityMinutes: profile.weekly_capacity_minutes,
        privateNote: profile.private_note,
        weeklySlots: (slotsByProfile.get(profile.id) ?? []).map((slot) => ({
          dayOfWeek: slot.day_of_week,
          startMinute: slot.start_minute,
          endMinute: slot.end_minute,
        })),
        exceptions: (exceptionsByProfile.get(profile.id) ?? []).map((exception) => ({
          exceptionDate: exception.exception_date,
          kind: exception.kind,
          startMinute: exception.start_minute,
          endMinute: exception.end_minute,
          privateNote: exception.private_note,
        })),
        revision: profile.revision,
      });
      result.set(profile.user_id, values);
    }
    return result;
  }

  private profileRows(userIds: string[]): AvailabilityProfileRow[] {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map(() => "?").join(", ");
    return this.dependencies.database.all<AvailabilityProfileRow>(
      `SELECT id, user_id, valid_from, valid_through, weekly_capacity_minutes,
              private_note, created_at, updated_at, revision
         FROM availability_profiles
        WHERE user_id IN (${placeholders})
        ORDER BY user_id, valid_from, id`,
      userIds,
    );
  }

  private slotRows(profileIds: string[]): AvailabilitySlotRow[] {
    if (profileIds.length === 0) return [];
    const placeholders = profileIds.map(() => "?").join(", ");
    return this.dependencies.database.all<AvailabilitySlotRow>(
      `SELECT profile_id, day_of_week, start_minute, end_minute
         FROM availability_slots
        WHERE profile_id IN (${placeholders})
        ORDER BY profile_id, day_of_week, start_minute, id`,
      profileIds,
    );
  }

  private exceptionRows(profileIds: string[]): AvailabilityExceptionRow[] {
    if (profileIds.length === 0) return [];
    const placeholders = profileIds.map(() => "?").join(", ");
    return this.dependencies.database.all<AvailabilityExceptionRow>(
      `SELECT profile_id, exception_date, kind, start_minute, end_minute,
              private_note
         FROM availability_exceptions
        WHERE profile_id IN (${placeholders})
        ORDER BY profile_id, exception_date, start_minute, id`,
      profileIds,
    );
  }

  private requireProjectMember(userId: string, projectId: string): void {
    const membership = this.dependencies.database.get<{ id: string }>(
      `SELECT projects.id FROM projects
         JOIN project_members ON project_members.project_id=projects.id
        WHERE projects.id=? AND project_members.user_id=?
          AND project_members.removed_at IS NULL
          AND projects.deleted_at IS NULL`,
      [projectId, userId],
    );
    if (membership === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
  }

  private projectMembers(projectId: string): ProjectMemberRow[] {
    return this.dependencies.database.all<ProjectMemberRow>(
      `SELECT project_members.user_id, users.username, users.display_name,
              project_members.color
         FROM project_members
         JOIN users ON users.id=project_members.user_id
        WHERE project_members.project_id=?
          AND project_members.removed_at IS NULL
          AND users.disabled_at IS NULL
        ORDER BY users.display_name COLLATE NOCASE, users.username COLLATE NOCASE`,
      [projectId],
    );
  }
}
