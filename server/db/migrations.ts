import { createHash } from "node:crypto";

import type { V2Database } from "./database.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

const baselineSchema = String.raw`
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE registration_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE team_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  start_date TEXT,
  end_date TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT,
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date),
  CHECK (
    (deleted_at IS NULL AND purge_after IS NULL) OR
    (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE project_invite_attempts (
  id TEXT PRIMARY KEY,
  project_invite_id TEXT REFERENCES project_invites(id) ON DELETE SET NULL,
  attempted_code_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
  attempted_at TEXT NOT NULL
);

CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date),
  UNIQUE (id, project_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  parent_id TEXT,
  recurring_rule_id TEXT,
  occurrence_date TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'pending_review', 'done')),
  start_date TEXT,
  due_date TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reopened_at TEXT,
  reopened_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date),
  CHECK (
    (deleted_at IS NULL AND purge_after IS NULL) OR
    (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
  ),
  UNIQUE (id, project_id),
  FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id),
  FOREIGN KEY (parent_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (recurring_rule_id, project_id) REFERENCES recurring_task_rules(id, project_id)
);

CREATE TABLE task_participants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes >= 0),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (start_date <= end_date),
  UNIQUE (task_id, user_id),
  UNIQUE (id, task_id, project_id),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id) ON DELETE CASCADE
);

CREATE TABLE progress_updates (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES task_participants(id) ON DELETE CASCADE,
  completion_percent INTEGER NOT NULL CHECK (completion_percent BETWEEN 0 AND 100),
  summary TEXT NOT NULL,
  blockers TEXT NOT NULL DEFAULT '',
  next_steps TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_task_id TEXT NOT NULL,
  successor_task_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (predecessor_task_id <> successor_task_id),
  UNIQUE (predecessor_task_id, successor_task_id),
  FOREIGN KEY (predecessor_task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (successor_task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'pending_review', 'done')),
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (id, project_id),
  FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id)
);

CREATE TABLE deliverable_requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  milestone_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  fulfilled_resource_id TEXT,
  fulfilled_at TEXT,
  fulfilled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (
    (task_id IS NOT NULL AND milestone_id IS NULL) OR
    (task_id IS NULL AND milestone_id IS NOT NULL)
  ),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (milestone_id, project_id) REFERENCES milestones(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (fulfilled_resource_id, project_id) REFERENCES resources(id, project_id)
);

CREATE TABLE recurring_task_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count >= 1),
  day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  next_occurrence_on TEXT NOT NULL,
  last_generated_on TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (ends_on IS NULL OR starts_on <= ends_on),
  CHECK (
    (frequency = 'weekly' AND day_of_week IS NOT NULL AND day_of_month IS NULL) OR
    (frequency = 'monthly' AND day_of_week IS NULL AND day_of_month IS NOT NULL)
  ),
  UNIQUE (id, project_id),
  FOREIGN KEY (source_task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE
);

CREATE TABLE availability_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_from TEXT NOT NULL,
  valid_through TEXT NOT NULL,
  weekly_capacity_minutes INTEGER NOT NULL CHECK (weekly_capacity_minutes >= 0),
  private_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (valid_from <= valid_through),
  UNIQUE (user_id, valid_from, valid_through)
);

CREATE TABLE availability_slots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES availability_profiles(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute INTEGER NOT NULL
    CHECK (start_minute >= 0 AND start_minute < 1440 AND start_minute % 30 = 0),
  end_minute INTEGER NOT NULL
    CHECK (end_minute > 0 AND end_minute <= 1440 AND end_minute % 30 = 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (start_minute < end_minute),
  UNIQUE (profile_id, day_of_week, start_minute, end_minute)
);

CREATE TABLE availability_exceptions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES availability_profiles(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('available', 'unavailable')),
  start_minute INTEGER NOT NULL
    CHECK (start_minute >= 0 AND start_minute < 1440 AND start_minute % 30 = 0),
  end_minute INTEGER NOT NULL
    CHECK (end_minute > 0 AND end_minute <= 1440 AND end_minute % 30 = 0),
  private_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (start_minute < end_minute),
  UNIQUE (profile_id, exception_date, kind, start_minute, end_minute)
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  source_task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'file')),
  title TEXT NOT NULL,
  current_version_number INTEGER NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purge_after TEXT,
  CHECK (
    (deleted_at IS NULL AND purge_after IS NULL) OR
    (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
  ),
  UNIQUE (id, project_id),
  FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id),
  FOREIGN KEY (source_task_id, project_id) REFERENCES tasks(id, project_id)
);

CREATE TABLE resource_versions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  original_filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  markdown_content TEXT,
  storage_key TEXT,
  version_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (
    (markdown_content IS NOT NULL AND storage_key IS NULL) OR
    (markdown_content IS NULL AND storage_key IS NOT NULL)
  ),
  UNIQUE (resource_id, version_number)
);

CREATE TABLE project_tags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (id, project_id),
  UNIQUE (project_id, name COLLATE NOCASE)
);

CREATE TABLE resource_tag_links (
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, tag_id),
  FOREIGN KEY (resource_id, project_id) REFERENCES resources(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id, project_id) REFERENCES project_tags(id, project_id) ON DELETE CASCADE
);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER before_delete_phase_clear_optional_references
BEFORE DELETE ON phases
FOR EACH ROW
BEGIN
  UPDATE tasks
     SET phase_id = NULL
   WHERE phase_id = OLD.id AND project_id = OLD.project_id;
  UPDATE milestones
     SET phase_id = NULL
   WHERE phase_id = OLD.id AND project_id = OLD.project_id;
  UPDATE resources
     SET phase_id = NULL
   WHERE phase_id = OLD.id AND project_id = OLD.project_id;
END;

CREATE TRIGGER before_delete_recurring_rule_clear_optional_references
BEFORE DELETE ON recurring_task_rules
FOR EACH ROW
BEGIN
  UPDATE tasks
     SET recurring_rule_id = NULL
   WHERE recurring_rule_id = OLD.id AND project_id = OLD.project_id;
END;

CREATE TRIGGER before_delete_task_clear_optional_references
BEFORE DELETE ON tasks
FOR EACH ROW
BEGIN
  UPDATE resources
     SET source_task_id = NULL
   WHERE source_task_id = OLD.id AND project_id = OLD.project_id;
END;

CREATE TRIGGER before_delete_resource_clear_optional_references
BEFORE DELETE ON resources
FOR EACH ROW
BEGIN
  UPDATE deliverable_requirements
     SET fulfilled_resource_id = NULL
   WHERE fulfilled_resource_id = OLD.id AND project_id = OLD.project_id;
END;

CREATE INDEX idx_sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX idx_project_members_user ON project_members(user_id, project_id);
CREATE INDEX idx_project_invites_active ON project_invites(project_id, expires_at, revoked_at);
CREATE INDEX idx_project_invite_attempts_limit
  ON project_invite_attempts(user_id, ip_address, attempted_at, succeeded);
CREATE INDEX idx_phases_project_position ON phases(project_id, position);
CREATE INDEX idx_tasks_project_phase_position ON tasks(project_id, phase_id, position);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_task_participants_user_dates
  ON task_participants(user_id, start_date, end_date);
CREATE INDEX idx_progress_updates_participant_created
  ON progress_updates(participant_id, created_at);
CREATE INDEX idx_task_dependencies_successor ON task_dependencies(successor_task_id);
CREATE INDEX idx_milestones_project_due ON milestones(project_id, due_date);
CREATE INDEX idx_deliverables_task ON deliverable_requirements(task_id);
CREATE INDEX idx_deliverables_milestone ON deliverable_requirements(milestone_id);
CREATE INDEX idx_recurring_rules_due ON recurring_task_rules(is_active, next_occurrence_on);
CREATE INDEX idx_availability_profiles_user_dates
  ON availability_profiles(user_id, valid_from, valid_through);
CREATE INDEX idx_availability_exceptions_profile_date
  ON availability_exceptions(profile_id, exception_date);
CREATE INDEX idx_resources_project_updated ON resources(project_id, updated_at);
CREATE INDEX idx_resource_versions_resource_version
  ON resource_versions(resource_id, version_number DESC);
CREATE INDEX idx_activity_log_project_created ON activity_log(project_id, created_at DESC);
`;

const task2AuthTeamProjectsSchema = String.raw`
ALTER TABLE team_members ADD COLUMN removed_at TEXT;
ALTER TABLE team_members ADD COLUMN removed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE project_members ADD COLUMN removed_at TEXT;
ALTER TABLE project_members ADD COLUMN removed_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,
  normalized_username TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'failed'
    CHECK (state IN ('pending', 'failed')),
  attempted_at TEXT NOT NULL
);

CREATE TABLE registration_hash_reservations (
  id TEXT PRIMARY KEY,
  authorization_key TEXT NOT NULL UNIQUE,
  reserved_at TEXT NOT NULL
);

CREATE INDEX idx_auth_attempts_username_time
  ON auth_attempts(normalized_username, attempted_at);
CREATE INDEX idx_auth_attempts_ip_time
  ON auth_attempts(ip_address, attempted_at);
CREATE INDEX idx_auth_attempts_attempted_at
  ON auth_attempts(attempted_at);

INSERT INTO team_members (user_id, joined_at, invited_by)
SELECT project_members.user_id, MIN(project_members.joined_at), NULL
  FROM project_members
  LEFT JOIN team_members ON team_members.user_id = project_members.user_id
 WHERE team_members.user_id IS NULL
 GROUP BY project_members.user_id;

CREATE INDEX idx_registration_hash_reservations_time
  ON registration_hash_reservations(reserved_at);
CREATE INDEX idx_team_members_active
  ON team_members(removed_at, user_id);
CREATE INDEX idx_project_members_active
  ON project_members(project_id, removed_at, user_id);

CREATE TRIGGER users_require_task_reassignment_before_disable
BEFORE UPDATE OF disabled_at ON users
WHEN OLD.disabled_at IS NULL
 AND NEW.disabled_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM task_participants
    WHERE user_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'user still has task participants that require reassignment');
END;

CREATE TRIGGER team_members_require_enabled_user_insert
BEFORE INSERT ON team_members
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM users
   WHERE id = NEW.user_id AND disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'team member must reference an enabled user');
END;

CREATE TRIGGER team_members_require_enabled_user_update
BEFORE UPDATE OF user_id, removed_at ON team_members
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM users
   WHERE id = NEW.user_id AND disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'team member must reference an enabled user');
END;

CREATE TRIGGER project_members_require_team_insert
BEFORE INSERT ON project_members
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM team_members
    JOIN users ON users.id = team_members.user_id
   WHERE team_members.user_id = NEW.user_id
     AND team_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project member must belong to team as an active team member');
END;

CREATE TRIGGER project_members_require_team_update
BEFORE UPDATE OF user_id, removed_at ON project_members
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM team_members
    JOIN users ON users.id = team_members.user_id
   WHERE team_members.user_id = NEW.user_id
     AND team_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project member must belong to team as an active team member');
END;

CREATE TRIGGER task_participants_require_active_member_insert
BEFORE INSERT ON task_participants
WHEN NOT EXISTS (
  SELECT 1
    FROM project_members
    JOIN users ON users.id = project_members.user_id
   WHERE project_members.project_id = NEW.project_id
     AND project_members.user_id = NEW.user_id
     AND project_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task participant must be an active project member with an enabled user');
END;

CREATE TRIGGER task_participants_require_active_member_update
BEFORE UPDATE OF project_id, user_id ON task_participants
WHEN NOT EXISTS (
  SELECT 1
    FROM project_members
    JOIN users ON users.id = project_members.user_id
   WHERE project_members.project_id = NEW.project_id
     AND project_members.user_id = NEW.user_id
     AND project_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task participant must be an active project member with an enabled user');
END;

CREATE TRIGGER project_members_preserve_task_participants
BEFORE UPDATE OF removed_at ON project_members
WHEN OLD.removed_at IS NULL
 AND NEW.removed_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM task_participants
    WHERE project_id = OLD.project_id AND user_id = OLD.user_id
 )
BEGIN
  SELECT RAISE(ABORT, 'project member still has task participants');
END;

CREATE TRIGGER team_members_preserve_active_project_memberships
BEFORE UPDATE OF removed_at ON team_members
WHEN OLD.removed_at IS NULL
 AND NEW.removed_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM project_members
    WHERE user_id = OLD.user_id AND removed_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'team member still has active project memberships');
END;

CREATE TRIGGER team_members_preserve_project_memberships
BEFORE DELETE ON team_members
WHEN EXISTS (
  SELECT 1 FROM project_members
   WHERE user_id = OLD.user_id AND removed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'team member still has project memberships');
END;
`;

const task3ScheduleSchema = String.raw`
ALTER TABLE projects
  ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 1
  CHECK (schedule_revision >= 1);

ALTER TABLE task_dependencies
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1);

ALTER TABLE task_dependencies
  ADD COLUMN deleted_at TEXT;

ALTER TABLE task_dependencies
  ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE task_participants
  ADD COLUMN removed_at TEXT;

ALTER TABLE task_participants
  ADD COLUMN removed_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE team_schedule_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  anchor_semantics TEXT NOT NULL DEFAULT 'relative_days'
    CHECK (anchor_semantics = 'relative_days'),
  payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (archived_at IS NULL AND archived_by IS NULL) OR
    archived_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX idx_team_schedule_templates_active_name
  ON team_schedule_templates(name COLLATE NOCASE)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX idx_tasks_recurring_occurrence
  ON tasks(recurring_rule_id, occurrence_date)
  WHERE recurring_rule_id IS NOT NULL
    AND occurrence_date IS NOT NULL
    AND deleted_at IS NULL;

CREATE TRIGGER task_participants_require_positive_estimate_insert
BEFORE INSERT ON task_participants
WHEN NEW.estimated_minutes <= 0
BEGIN
  SELECT RAISE(ABORT, 'participant estimated minutes must be positive');
END;

CREATE TRIGGER task_participants_require_positive_estimate_update
BEFORE UPDATE OF estimated_minutes ON task_participants
WHEN NEW.estimated_minutes <= 0
BEGIN
  SELECT RAISE(ABORT, 'participant estimated minutes must be positive');
END;

CREATE TRIGGER progress_updates_are_immutable_update
BEFORE UPDATE ON progress_updates
BEGIN
  SELECT RAISE(ABORT, 'progress updates are immutable');
END;

CREATE TRIGGER progress_updates_are_immutable_delete
BEFORE DELETE ON progress_updates
BEGIN
  SELECT RAISE(ABORT, 'progress updates are immutable');
END;

DROP TRIGGER users_require_task_reassignment_before_disable;
DROP TRIGGER task_participants_require_active_member_insert;
DROP TRIGGER task_participants_require_active_member_update;
DROP TRIGGER project_members_preserve_task_participants;

CREATE TRIGGER users_require_active_task_reassignment_before_disable
BEFORE UPDATE OF disabled_at ON users
WHEN OLD.disabled_at IS NULL
 AND NEW.disabled_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM task_participants
    WHERE user_id = OLD.id AND removed_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'user still has active task participants that require reassignment');
END;

CREATE TRIGGER task_participants_require_active_member_insert
BEFORE INSERT ON task_participants
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM project_members
    JOIN users ON users.id = project_members.user_id
   WHERE project_members.project_id = NEW.project_id
     AND project_members.user_id = NEW.user_id
     AND project_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task participant must be an active project member with an enabled user');
END;

CREATE TRIGGER task_participants_require_active_member_update
BEFORE UPDATE OF project_id, user_id, removed_at ON task_participants
WHEN NEW.removed_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM project_members
    JOIN users ON users.id = project_members.user_id
   WHERE project_members.project_id = NEW.project_id
     AND project_members.user_id = NEW.user_id
     AND project_members.removed_at IS NULL
     AND users.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task participant must be an active project member with an enabled user');
END;

CREATE TRIGGER project_members_preserve_active_task_participants
BEFORE UPDATE OF removed_at ON project_members
WHEN OLD.removed_at IS NULL
 AND NEW.removed_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM task_participants
    WHERE project_id = OLD.project_id
      AND user_id = OLD.user_id
      AND removed_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'project member still has active task participants');
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "v2_baseline",
    sql: baselineSchema,
    checksum: migrationChecksum(baselineSchema),
  },
  {
    version: 2,
    name: "task2_auth_team_projects",
    sql: task2AuthTeamProjectsSchema,
    checksum: migrationChecksum(task2AuthTeamProjectsSchema),
  },
  {
    version: 3,
    name: "task3_schedule_domain",
    sql: task3ScheduleSchema,
    checksum: migrationChecksum(task3ScheduleSchema),
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

function ensureMigrationTable(database: V2Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    )
  `);

  const columns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(schema_migrations)")
      .map(({ name }) => name),
  );
  const requiredColumns = ["version", "name", "checksum", "applied_at"];
  const missingColumns = requiredColumns.filter((name) => !columns.has(name));

  if (missingColumns.length > 0) {
    throw new Error(
      `Incompatible schema_migrations table: required columns are version, name, checksum, applied_at; missing ${missingColumns.join(", ")}.`,
    );
  }
}

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

function validateAppliedMigrations(rows: AppliedMigration[]): void {
  const migrationsByVersion = new Map(
    MIGRATIONS.map((migration) => [migration.version, migration]),
  );

  for (const row of rows) {
    const expected = migrationsByVersion.get(row.version);
    if (!expected) {
      if (row.version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Database schema version ${row.version} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`,
        );
      }
      throw new Error(
        `Unsupported database schema migration version ${row.version}.`,
      );
    }

    if (row.name !== expected.name) {
      throw new Error(
        `Applied migration ${row.version} name mismatch: expected "${expected.name}", found "${row.name}".`,
      );
    }

    const expectedChecksum = migrationChecksum(expected.sql);
    if (row.checksum !== expectedChecksum) {
      throw new Error(
        `Applied migration ${row.version} checksum mismatch: expected "${expectedChecksum}", found "${row.checksum}".`,
      );
    }
  }
}

export function migrateV2Database(
  database: V2Database,
  now: () => string = () => new Date().toISOString(),
): void {
  ensureMigrationTable(database);

  database.transaction(() => {
    const appliedMigrations = database.all<AppliedMigration>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    validateAppliedMigrations(appliedMigrations);
    const appliedVersions = new Set(
      appliedMigrations.map(({ version }) => version),
    );

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      database.exec(migration.sql);
      const checksum = migrationChecksum(migration.sql);
      database.run(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        [migration.version, migration.name, checksum, now()],
      );
    }
  });
}
