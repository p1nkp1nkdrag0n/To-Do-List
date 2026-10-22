/**
 * MCP 运行时：把现有的数据库 + 服务层装进一个 stdio 子进程。
 *
 * 这里不引入新的权限体系：MCP 用一个"演示身份"跑，它就是团队里最早加入的那个人
 * （默认 qyhsktn），能看到的项目和任务跟他在网页里看到的完全一致。
 *
 * 需要换身份时设环境变量 MCP_USERNAME；需要锁定项目时设 MCP_PROJECT_ID。
 */
import { parseConfig } from "../config/env.js";
import { openV2Database, type V2Database } from "../db/database.js";
import { migrateV2Database } from "../db/migrations.js";
import { resolveDependencies, type V2RuntimeDependencies } from "../http/dependencies.js";
import { AvailabilityService } from "../modules/availability/availability-service.js";
import type { AuthenticatedSession } from "../modules/auth/auth-service.js";
import { ProjectService } from "../modules/projects/project-service.js";
import { ScheduleService } from "../modules/schedule/schedule-service.js";
import { TeamService } from "../modules/team/team-service.js";

interface UserRow extends Record<string, unknown> {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  revision: number;
  team_member: number;
}

export interface McpRuntimeOptions {
  dbPath?: string;
  username?: string;
  projectId?: string;
}

export interface McpRuntime {
  database: V2Database;
  dependencies: V2RuntimeDependencies;
  auth: AuthenticatedSession;
  availability: AvailabilityService;
  schedule: ScheduleService;
  projects: ProjectService;
  team: TeamService;
  /** 调用方没传 projectId 时用的默认项目。 */
  defaultProjectId: string | undefined;
  resolveProjectId(requested?: string): string;
  close(): void;
}

function loadUser(
  database: V2Database,
  username: string | undefined,
): UserRow {
  const row =
    username === undefined
      ? database.get<UserRow>(
          `SELECT users.id, users.username, users.display_name, users.created_at,
                  users.updated_at, users.revision,
                  CASE WHEN team_members.user_id IS NULL THEN 0 ELSE 1 END AS team_member
             FROM users
             LEFT JOIN team_members
               ON team_members.user_id = users.id AND team_members.removed_at IS NULL
            WHERE users.disabled_at IS NULL
            ORDER BY team_members.joined_at ASC, users.created_at ASC
            LIMIT 1`,
        )
      : database.get<UserRow>(
          `SELECT users.id, users.username, users.display_name, users.created_at,
                  users.updated_at, users.revision,
                  CASE WHEN team_members.user_id IS NULL THEN 0 ELSE 1 END AS team_member
             FROM users
             LEFT JOIN team_members
               ON team_members.user_id = users.id AND team_members.removed_at IS NULL
            WHERE users.disabled_at IS NULL AND users.username = ? COLLATE NOCASE
            LIMIT 1`,
          [username],
        );
  if (row === undefined) {
    throw new Error(
      username === undefined
        ? "数据库里还没有任何可用账号，请先在网页里完成首次注册。"
        : `找不到账号 ${username}，可用 MCP_USERNAME 指定其他账号。`,
    );
  }
  return row;
}

export function createMcpRuntime(options: McpRuntimeOptions = {}): McpRuntime {
  const config = parseConfig();
  const dbPath = options.dbPath ?? config.dbPath;
  const database = openV2Database(dbPath);
  migrateV2Database(database);

  const dependencies = resolveDependencies({
    database,
    sessionSecret: config.sessionSecret,
    cookieSecure: false,
    bootstrapCode: config.bootstrapCode,
  });

  const user = loadUser(database, options.username ?? process.env.MCP_USERNAME);
  const auth: AuthenticatedSession = {
    sessionId: "mcp-stdio",
    tokenHash: "mcp-stdio",
    teamMember: user.team_member === 1,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      revision: user.revision,
    },
  };

  const projects = new ProjectService(dependencies);
  const visibleProjects = projects.list(auth);
  const defaultProjectId =
    options.projectId ??
    process.env.MCP_PROJECT_ID ??
    visibleProjects[0]?.id;

  return {
    database,
    dependencies,
    auth,
    availability: new AvailabilityService(dependencies),
    schedule: new ScheduleService(dependencies),
    projects,
    team: new TeamService(dependencies),
    defaultProjectId,
    resolveProjectId(requested?: string): string {
      const projectId = requested ?? defaultProjectId;
      if (projectId === undefined) {
        throw new Error(
          `当前账号 ${auth.user.username} 看不到任何项目，请先在网页里创建项目。`,
        );
      }
      return projectId;
    },
    close(): void {
      database.close();
    },
  };
}
