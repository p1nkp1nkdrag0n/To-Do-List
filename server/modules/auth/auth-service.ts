import { createHash } from "node:crypto";

import type { LoginRequest, RegisterRequest } from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import {
  ATTEMPT_RETENTION_MS,
  REGISTRATION_HASH_RESERVATION_TIMEOUT_MS,
} from "../attempt-housekeeping.js";
import { registrationInviteDigest } from "../registration-invites/registration-invite-crypto.js";

const SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const AUTH_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const DUMMY_PASSWORD_HASH =
  "$2a$10$sVbWZn7SSXtOrTuqSFd5nO7ME8YKLv.NihvcSfbPyZbF0JZlsivX.";

interface UserRow extends Record<string, unknown> {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface LoginUserRow extends UserRow {
  team_member: number;
}

type RegistrationAuthorization =
  | { firstAccount: true; authorizationKey: "bootstrap" }
  | {
      firstAccount: false;
      authorizationKey: string;
      registrationInviteId: string;
    };

interface RegistrationReservation {
  id: string;
  authorization: RegistrationAuthorization;
}

type LoginDecision =
  | { kind: "invalid" }
  | {
      kind: "success";
      token: string;
      user: PublicUser;
      teamMember: boolean;
    };

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AuthenticatedSession {
  sessionId: string;
  tokenHash: string;
  user: PublicUser;
  teamMember: boolean;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export class AuthService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  async register(input: RegisterRequest): Promise<{
    user: PublicUser;
    teamMember: boolean;
  }> {
    const reservation = this.reserveRegistrationHash(input);
    try {
      const passwordHash = await this.dependencies.passwordHasher(input.password);

      return this.dependencies.database.transaction(() => {
        const now = this.dependencies.clock().toISOString();
        const heldReservation = this.dependencies.database.get<{ id: string }>(
          `SELECT id FROM registration_hash_reservations
            WHERE id = ? AND authorization_key = ?`,
          [reservation.id, reservation.authorization.authorizationKey],
        );
        if (heldReservation === undefined) {
          throw this.registrationAuthorizationUnavailable(
            reservation.authorization,
          );
        }
        this.assertUsernameAvailable(input.username);
        const authorization = this.authorizeRegistration(input, now);
        if (
          authorization.authorizationKey !==
          reservation.authorization.authorizationKey
        ) {
          throw this.registrationAuthorizationUnavailable(
            reservation.authorization,
          );
        }

        const userId = this.dependencies.idGenerator();
        this.dependencies.database.run(
          `INSERT INTO users
            (id, username, password_hash, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, input.username, passwordHash, input.displayName, now, now],
        );
        if (!authorization.firstAccount) {
          const consumed = this.dependencies.database.run(
            `UPDATE registration_invites
                SET used_at = ?, used_by = ?, revision = revision + 1
              WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
            [now, userId, authorization.registrationInviteId, now],
          );
          if (consumed.changes !== 1) {
            throw this.registrationInviteInvalid();
          }
          writeActivity(this.dependencies, {
            actorId: userId,
            entityType: "registration_invite",
            entityId: authorization.registrationInviteId,
            action: "registration_invite.used",
          });
        }
        if (authorization.firstAccount) {
          this.dependencies.database.run(
            `INSERT INTO team_members (user_id, joined_at, invited_by)
             VALUES (?, ?, NULL)`,
            [userId, now],
          );
        }
        const released = this.dependencies.database.run(
          `DELETE FROM registration_hash_reservations
            WHERE id = ? AND authorization_key = ?`,
          [reservation.id, authorization.authorizationKey],
        );
        if (released.changes !== 1) {
          throw new Error("The registration hash reservation is unavailable.");
        }
        writeActivity(this.dependencies, {
          actorId: userId,
          entityType: "user",
          entityId: userId,
          action: "auth.registered",
        });

        return {
          user: {
            id: userId,
            username: input.username,
            displayName: input.displayName,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          },
          teamMember: authorization.firstAccount,
        };
      });
    } catch (error) {
      this.releaseRegistrationHash(reservation.id);
      throw error;
    }
  }

  async login(input: LoginRequest, ipAddress: string): Promise<{
    token: string;
    user: PublicUser;
    teamMember: boolean;
  }> {
    const reservationId = this.reserveLoginAdmission(input.username, ipAddress);
    if (reservationId === undefined) {
      throw this.loginRateLimited();
    }

    let decision: LoginDecision;
    try {
      const candidate = this.findLoginUser(input.username);
      const comparisonHash =
        candidate !== undefined && candidate.disabled_at === null
          ? candidate.password_hash
          : DUMMY_PASSWORD_HASH;
      const passwordValid = await this.dependencies.passwordVerifier(
        input.password,
        comparisonHash,
      );
      const token =
        passwordValid && candidate !== undefined && candidate.disabled_at === null
          ? this.dependencies.sessionTokenGenerator()
          : undefined;

      decision = this.dependencies.database.transaction<LoginDecision>(() => {
        const latest = this.findLoginUser(input.username);
        const stillValid =
          passwordValid &&
          token !== undefined &&
          candidate !== undefined &&
          candidate.disabled_at === null &&
          latest !== undefined &&
          latest.disabled_at === null &&
          latest.id === candidate.id &&
          latest.password_hash === candidate.password_hash;

        if (!stillValid || latest === undefined) {
          const finalized = this.dependencies.database.run(
            `UPDATE auth_attempts
                SET state = 'failed'
              WHERE id = ? AND state = 'pending'`,
            [reservationId],
          );
          if (finalized.changes !== 1) {
            throw new Error("The login admission reservation is unavailable.");
          }
          return { kind: "invalid" };
        }

        const released = this.dependencies.database.run(
          "DELETE FROM auth_attempts WHERE id = ? AND state = 'pending'",
          [reservationId],
        );
        if (released.changes !== 1) {
          throw new Error("The login admission reservation is unavailable.");
        }
        this.dependencies.database.run(
          `DELETE FROM auth_attempts
            WHERE state = 'failed'
              AND normalized_username = ?
              AND ip_address = ?`,
          [input.username, ipAddress],
        );
        const now = this.dependencies.clock();
        const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
        this.dependencies.database.run(
          `INSERT INTO sessions
            (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            this.dependencies.idGenerator(),
            latest.id,
            sha256(token),
            expiresAt.toISOString(),
            now.toISOString(),
            now.toISOString(),
          ],
        );
        writeActivity(this.dependencies, {
          actorId: latest.id,
          entityType: "session",
          action: "auth.logged_in",
        });
        return {
          kind: "success",
          token,
          user: publicUser(latest),
          teamMember: latest.team_member === 1,
        };
      });
    } catch (error) {
      this.releaseLoginAdmission(reservationId);
      throw error;
    }

    if (decision.kind === "invalid") {
      throw new HttpError(
        401,
        "INVALID_CREDENTIALS",
        "The username or password is invalid.",
      );
    }
    return decision;
  }

  authenticate(token: string | undefined): AuthenticatedSession {
    if (token === undefined || token === "") {
      throw this.authRequired();
    }
    const tokenHash = sha256(token);
    const row = this.dependencies.database.get<
      UserRow & { session_id: string; token_hash: string; expires_at: string; team_member: number }
    >(
      `SELECT users.*,
              sessions.id AS session_id,
              sessions.token_hash,
              sessions.expires_at,
              CASE WHEN team_members.user_id IS NULL THEN 0 ELSE 1 END AS team_member
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         LEFT JOIN team_members
           ON team_members.user_id = users.id
          AND team_members.removed_at IS NULL
        WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`,
      [tokenHash],
    );
    if (
      row === undefined ||
      row.disabled_at !== null ||
      row.expires_at <= this.dependencies.clock().toISOString()
    ) {
      throw this.authRequired();
    }
    return {
      sessionId: row.session_id,
      tokenHash: row.token_hash,
      user: publicUser(row),
      teamMember: row.team_member === 1,
    };
  }

  logout(session: AuthenticatedSession): void {
    const now = this.dependencies.clock().toISOString();
    this.dependencies.database.transaction(() => {
      this.dependencies.database.run(
        `UPDATE sessions
            SET revoked_at = ?, revision = revision + 1
          WHERE id = ? AND revoked_at IS NULL`,
        [now, session.sessionId],
      );
      writeActivity(this.dependencies, {
        actorId: session.user.id,
        entityType: "session",
        entityId: session.sessionId,
        action: "auth.logged_out",
      });
    });
  }

  private authRequired(): HttpError {
    return new HttpError(401, "AUTH_REQUIRED", "Authentication is required.");
  }

  private assertUsernameAvailable(username: string): void {
    const existing = this.dependencies.database.get<{ id: string }>(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE",
      [username],
    );
    if (existing !== undefined) {
      throw new HttpError(409, "USERNAME_TAKEN", "That username is already registered.");
    }
  }

  private reserveRegistrationHash(
    input: RegisterRequest,
  ): RegistrationReservation {
    return this.dependencies.database.transaction(() => {
      const now = this.dependencies.clock();
      this.dependencies.database.run(
        "DELETE FROM registration_hash_reservations WHERE reserved_at < ?",
        [
          new Date(
            now.getTime() - REGISTRATION_HASH_RESERVATION_TIMEOUT_MS,
          ).toISOString(),
        ],
      );
      this.assertUsernameAvailable(input.username);
      const authorization = this.authorizeRegistration(
        input,
        now.toISOString(),
      );
      const existing = this.dependencies.database.get<{ id: string }>(
        `SELECT id FROM registration_hash_reservations
          WHERE authorization_key = ?`,
        [authorization.authorizationKey],
      );
      if (existing !== undefined) {
        throw this.registrationAuthorizationUnavailable(authorization);
      }

      const id = this.dependencies.idGenerator();
      this.dependencies.database.run(
        `INSERT INTO registration_hash_reservations
          (id, authorization_key, reserved_at)
         VALUES (?, ?, ?)`,
        [id, authorization.authorizationKey, now.toISOString()],
      );
      return { id, authorization };
    });
  }

  private releaseRegistrationHash(reservationId: string): void {
    try {
      this.dependencies.database.transaction(() => {
        this.dependencies.database.run(
          "DELETE FROM registration_hash_reservations WHERE id = ?",
          [reservationId],
        );
      });
    } catch (error) {
      this.dependencies.logger.error(error, {
        method: "INTERNAL",
        path: "auth.register.release_reservation",
      });
    }
  }

  private authorizeRegistration(
    input: RegisterRequest,
    now: string,
  ): RegistrationAuthorization {
    const userCount = this.dependencies.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    )?.count ?? 0;
    if (userCount === 0) {
      if (input.bootstrapCode !== this.dependencies.bootstrapCode) {
        throw new HttpError(
          403,
          "BOOTSTRAP_CODE_INVALID",
          "The bootstrap code is invalid.",
        );
      }
      return { firstAccount: true, authorizationKey: "bootstrap" };
    }

    const invite = this.dependencies.database.get<{ id: string }>(
      `SELECT registration_invites.id
         FROM registration_invites
         JOIN users AS creator_users
           ON creator_users.id = registration_invites.created_by
          AND creator_users.disabled_at IS NULL
         JOIN team_members AS creator_members
           ON creator_members.user_id = registration_invites.created_by
          AND creator_members.removed_at IS NULL
        WHERE registration_invites.code_hash = ?
          AND registration_invites.used_at IS NULL
          AND registration_invites.revoked_at IS NULL
          AND registration_invites.expires_at > ?`,
      [registrationInviteDigest(input.registrationInviteCode ?? ""), now],
    );
    if (invite === undefined) {
      throw this.registrationInviteInvalid();
    }
    return {
      firstAccount: false,
      authorizationKey: `registration_invite:${invite.id}`,
      registrationInviteId: invite.id,
    };
  }

  private registrationAuthorizationUnavailable(
    authorization: RegistrationAuthorization,
  ): HttpError {
    return authorization.firstAccount
      ? new HttpError(
          403,
          "BOOTSTRAP_CODE_INVALID",
          "The bootstrap code is invalid.",
        )
      : this.registrationInviteInvalid();
  }

  private registrationInviteInvalid(): HttpError {
    return new HttpError(
      403,
      "REGISTRATION_INVITE_INVALID",
      "The registration invite is invalid or unavailable.",
    );
  }

  private findLoginUser(username: string): LoginUserRow | undefined {
    return this.dependencies.database.get<LoginUserRow>(
      `SELECT users.*,
              CASE WHEN team_members.user_id IS NULL THEN 0 ELSE 1 END AS team_member
         FROM users
         LEFT JOIN team_members
           ON team_members.user_id = users.id
          AND team_members.removed_at IS NULL
        WHERE users.username = ? COLLATE NOCASE`,
      [username],
    );
  }

  private purgeStaleAuthAttempts(now: Date): void {
    this.dependencies.database.run(
      "DELETE FROM auth_attempts WHERE attempted_at < ?",
      [new Date(now.getTime() - ATTEMPT_RETENTION_MS).toISOString()],
    );
  }

  private reserveLoginAdmission(
    username: string,
    ipAddress: string,
  ): string | undefined {
    return this.dependencies.database.transaction(() => {
      const now = this.dependencies.clock();
      this.purgeStaleAuthAttempts(now);
      const cutoff = new Date(
        now.getTime() - AUTH_ATTEMPT_WINDOW_MS,
      ).toISOString();
      const usernameCount =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM auth_attempts
            WHERE normalized_username = ? AND attempted_at > ?`,
          [username, cutoff],
        )?.count ?? 0;
      const ipCount =
        this.dependencies.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM auth_attempts
            WHERE ip_address = ? AND attempted_at > ?`,
          [ipAddress, cutoff],
        )?.count ?? 0;
      if (
        usernameCount >= MAX_FAILED_LOGIN_ATTEMPTS ||
        ipCount >= MAX_FAILED_LOGIN_ATTEMPTS
      ) {
        return undefined;
      }

      const reservationId = this.dependencies.idGenerator();
      this.dependencies.database.run(
        `INSERT INTO auth_attempts
          (id, normalized_username, ip_address, state, attempted_at)
         VALUES (?, ?, ?, 'pending', ?)`,
        [reservationId, username, ipAddress, now.toISOString()],
      );
      return reservationId;
    });
  }

  private releaseLoginAdmission(reservationId: string): void {
    try {
      this.dependencies.database.transaction(() => {
        this.dependencies.database.run(
          "DELETE FROM auth_attempts WHERE id = ? AND state = 'pending'",
          [reservationId],
        );
      });
    } catch (error) {
      this.dependencies.logger.error(error, {
        method: "INTERNAL",
        path: "auth.login.release_reservation",
      });
    }
  }

  private loginRateLimited(): HttpError {
    return new HttpError(
      429,
      "AUTH_RATE_LIMITED",
      "Too many failed login attempts. Try again later.",
    );
  }
}

export const sessionDurationSeconds = SESSION_DURATION_MS / 1000;
