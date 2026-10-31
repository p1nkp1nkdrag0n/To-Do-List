/**
 * 一次 cleanup 要关闭的 socket 集合。
 *
 * stop() 会把 socket 从 wsRef 移到 closingSocketRef；unmount 时两处都可能存在，
 * 也可能指向同一个对象。这里统一去重，避免“只取 wsRef，把待关闭的旧 socket 漏掉”。
 */
export function socketsToClose<T>(
  active: T | undefined,
  closing: T | undefined,
): T[] {
  const sockets: T[] = [];
  if (active !== undefined) sockets.push(active);
  if (closing !== undefined && closing !== active) sockets.push(closing);
  return sockets;
}
