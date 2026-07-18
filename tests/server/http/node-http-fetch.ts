import { request } from "node:http";

export function nodeHttpFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const headers = new Headers(init.headers);
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new TypeError("nodeHttpFetch only supports string and Buffer request bodies.");
  }
  const bodyBuffer = body === undefined || body === null
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(body);
  if (bodyBuffer !== undefined && !headers.has("content-length")) {
    headers.set("content-length", String(bodyBuffer.byteLength));
  }

  return new Promise((resolve, reject) => {
    const operation = request(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          const responseBody = Buffer.concat(chunks);
          resolve(new Response(responseBody.length === 0 ? null : responseBody, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }));
        });
      },
    );
    operation.on("error", reject);
    operation.end(bodyBuffer);
  });
}
