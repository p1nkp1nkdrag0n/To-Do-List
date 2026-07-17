import type { ErrorRequestHandler, Response } from "express";
import type { ZodError } from "zod";

import type { ApiErrorPayload } from "../../shared/contracts.js";

export interface V2Logger {
  error(error: unknown, context: { method: string; path: string }): void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: {
      fieldErrors?: Record<string, string[]>;
      latest?: unknown;
    } = {},
  ) {
    super(message);
  }
}

export function validationError(error: ZodError): HttpError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path[0]?.toString() ?? "_root";
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new HttpError(400, "VALIDATION_ERROR", "The request payload is invalid.", {
    fieldErrors,
  });
}

export function sendHttpError(response: Response, error: HttpError): void {
  const payload: ApiErrorPayload = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details.fieldErrors === undefined
        ? {}
        : { fieldErrors: error.details.fieldErrors }),
      ...(error.details.latest === undefined ? {} : { latest: error.details.latest }),
    },
  };
  response.status(error.status).json(payload);
}

export function createV2ErrorHandler(logger: V2Logger): ErrorRequestHandler {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof HttpError) {
      sendHttpError(response, error);
      return;
    }

    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
      sendHttpError(
        response,
        new HttpError(413, "PAYLOAD_TOO_LARGE", "The request payload exceeds 1 MiB."),
      );
      return;
    }
    if (bodyError.status === 400 && bodyError.type === "entity.parse.failed") {
      sendHttpError(
        response,
        new HttpError(400, "INVALID_JSON", "The request body is not valid JSON."),
      );
      return;
    }

    logger.error(error, { method: request.method, path: request.originalUrl });
    sendHttpError(
      response,
      new HttpError(500, "INTERNAL_ERROR", "An unexpected error occurred."),
    );
  };
}
