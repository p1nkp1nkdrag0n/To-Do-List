import { describe, expect, it } from "vitest";

import { socketsToClose } from "../../src/features/meeting/realtime-sockets.js";

describe("cleanup 时要关闭的 socket", () => {
  it("stop 后 wsRef 为空，closing 里的旧 socket 仍要被关闭", () => {
    const closing = { name: "old" };
    expect(socketsToClose(undefined, closing)).toEqual([closing]);
  });

  it("stop 后立即 unmount：active 与 closing 同时存在时两个都关", () => {
    const active = { name: "new" };
    const closing = { name: "old" };
    expect(socketsToClose(active, closing)).toEqual([active, closing]);
  });

  it("连续 stop：同一个 socket 只关一次", () => {
    const socket = { name: "same" };
    expect(socketsToClose(socket, socket)).toEqual([socket]);
  });

  it("两处都为空时返回空数组", () => {
    expect(socketsToClose(undefined, undefined)).toEqual([]);
  });
});
