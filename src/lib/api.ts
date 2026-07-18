export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    latest?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
    readonly latest?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let payload: ApiErrorPayload | undefined;
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      // The server normally returns the shared error shape; retain a useful fallback.
    }
    throw new ApiError(
      response.status,
      payload?.error.code ?? "REQUEST_FAILED",
      payload?.error.message ?? `请求失败 (${response.status})`,
      payload?.error.fieldErrors,
      payload?.error.latest,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: "POST", body: jsonBody(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: jsonBody(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: jsonBody(body) }),
  delete: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "DELETE", body: jsonBody(body) }),
  multipart: <T>(path: string, metadata: unknown, file?: File) => {
    const body = new FormData();
    body.set("metadata", JSON.stringify(metadata));
    if (file !== undefined) body.set("file", file);
    return request<T>(path, { method: "POST", body });
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知错误，请重试。";
}
