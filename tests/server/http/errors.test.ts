import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  createV2ErrorHandler,
  HttpError,
} from "../../../server/http/errors.js";

function requestStub(): Request {
  return {
    method: "POST",
    originalUrl: "/api/private-action",
  } as Request;
}

describe("v2 error middleware", () => {
  it("delegates the original error after response headers were sent", () => {
    const logger = { error: vi.fn() };
    const next = vi.fn() as NextFunction;
    const response = { headersSent: true } as Response;
    const error = new Error("stream failed");

    createV2ErrorHandler(logger)(error, requestStub(), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(error);
  });

  it("logs unexpected failures without exposing their details", () => {
    const logger = { error: vi.fn() };
    const status = vi.fn();
    const json = vi.fn();
    const response = {
      headersSent: false,
      status,
      json,
    } as unknown as Response;
    status.mockReturnValue(response);
    const next = vi.fn() as NextFunction;
    const error = new Error("database password=do-not-leak");

    createV2ErrorHandler(logger)(error, requestStub(), response, next);

    expect(logger.error).toHaveBeenCalledWith(error, {
      method: "POST",
      path: "/api/private-action",
    });
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("do-not-leak");
    expect(next).not.toHaveBeenCalled();
  });

  it("does not log expected HTTP errors", () => {
    const logger = { error: vi.fn() };
    const status = vi.fn();
    const json = vi.fn();
    const response = {
      headersSent: false,
      status,
      json,
    } as unknown as Response;
    status.mockReturnValue(response);

    createV2ErrorHandler(logger)(
      new HttpError(409, "EXPECTED", "Expected conflict."),
      requestStub(),
      response,
      vi.fn(),
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(409);
  });
});
