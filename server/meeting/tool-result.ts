/** MCP 工具结果的统一校验：失败不能被当成 0 或空。 */
export interface ToolOutcomeLike {
  ok: boolean;
  payload: Record<string, unknown>;
  summary: string;
}

export function requireToolOk(outcome: ToolOutcomeLike, tool: string): void {
  if (!outcome.ok) {
    throw new Error(`${tool} 失败：${outcome.summary}`);
  }
}

export function requireNumberField(
  outcome: ToolOutcomeLike,
  field: string,
  tool: string,
): number {
  const value = outcome.payload[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${tool} 返回缺少 ${field}，无法判断结果。`);
  }
  return value;
}
