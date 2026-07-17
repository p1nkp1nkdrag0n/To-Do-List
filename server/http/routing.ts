import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import { validationError } from "./errors.js";

export function parseRequestBody<Output>(
  schema: ZodType<Output>,
  request: Request,
): Output {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    throw validationError(result.error);
  }
  return result.data;
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (request, response, next): void => {
    void handler(request, response, next).catch(next);
  };
}
