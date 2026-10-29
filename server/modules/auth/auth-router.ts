import os from "node:os";

import { Router, type NextFunction, type Request, type Response } from "express";

import {
  BootstrapAdminRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
} from "../../../shared/contracts.js";
import { parseCookieHeader } from "../../http/cookies.js";
import { HttpError } from "../../http/errors.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { asyncRoute, parseRequestBody } from "../../http/routing.js";
import {
  AuthService,
  type AuthenticatedSession,
  sessionDurationSeconds,
} from "./auth-service.js";

/** 首次初始化只允许本机：避免局域网里有人抢先创建管理员。 */
function isLocalRequest(request: Request): boolean {
  const raw = request.ip ?? request.socket.remoteAddress ?? "";
  const ip = raw.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address === ip) return true;
    }
  }
  return false;
}

export interface AuthLocals {
  auth: AuthenticatedSession;
}

export function createAuthRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new AuthService(dependencies);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: dependencies.cookieSecure,
    path: "/",
  };

  const requireAuth = (
    request: Request,
    response: Response<unknown, AuthLocals>,
    next: NextFunction,
  ): void => {
    try {
      const cookies = parseCookieHeader(request.headers.cookie);
      response.locals.auth = service.authenticate(cookies.team_session);
      next();
    } catch (error) {
      next(error);
    }
  };

  /** 首启向导：只有空库时才需要/允许。 */
  router.get("/bootstrap-status", (_request, response) => {
    response.json({ needsBootstrap: service.needsBootstrap() });
  });

  router.post(
    "/bootstrap",
    asyncRoute(async (request, response) => {
      if (!isLocalRequest(request)) {
        throw new HttpError(
          403,
          "BOOTSTRAP_LOCAL_ONLY",
          "首次初始化只能在本机完成：请在这台电脑上打开 127.0.0.1 地址后再创建管理员。",
        );
      }
      const result = await service.bootstrapAdmin(
        parseRequestBody(BootstrapAdminRequestSchema, request),
        request.ip ?? request.socket.remoteAddress ?? "unknown",
      );
      response.cookie("team_session", result.token, {
        ...cookieOptions,
        maxAge: sessionDurationSeconds * 1000,
      });
      response.status(201).json({ user: result.user, teamMember: result.teamMember });
    }),
  );

  router.post(
    "/register",
    asyncRoute(async (request, response) => {
      const result = await service.register(parseRequestBody(RegisterRequestSchema, request));
      response.status(201).json(result);
    }),
  );

  router.post(
    "/login",
    asyncRoute(async (request, response) => {
      const result = await service.login(
        parseRequestBody(LoginRequestSchema, request),
        request.ip ?? request.socket.remoteAddress ?? "unknown",
      );
      response.cookie("team_session", result.token, {
        ...cookieOptions,
        maxAge: sessionDurationSeconds * 1000,
      });
      response.json({ user: result.user, teamMember: result.teamMember });
    }),
  );

  router.get(
    "/me",
    requireAuth,
    (_request, response: Response<unknown, AuthLocals>) => {
      response.json({
        user: response.locals.auth.user,
        teamMember: response.locals.auth.teamMember,
      });
    },
  );

  router.post(
    "/logout",
    requireAuth,
    (_request, response: Response<unknown, AuthLocals>) => {
      service.logout(response.locals.auth);
      response.clearCookie("team_session", cookieOptions);
      response.status(204).end();
    },
  );

  return router;
}

export function createRequireAuth(
  dependencies: V2RuntimeDependencies,
): (
  request: Request,
  response: Response<unknown, AuthLocals>,
  next: NextFunction,
) => void {
  const service = new AuthService(dependencies);
  return (request, response, next): void => {
    try {
      response.locals.auth = service.authenticate(
        parseCookieHeader(request.headers.cookie).team_session,
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}
