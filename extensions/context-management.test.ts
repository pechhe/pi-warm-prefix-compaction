import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_CONFIG, normalizeTransportNoise, parseRecoveryHandle, projectContextMessages, recoveryHandle } from "./context-management.ts";

const tool = (text: string, extra: Record<string, unknown> = {}) => ({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text }], ...extra });

describe("shared deterministic context management", () => {
  test("small results remain byte-equivalent", () => {
    const input = [tool("hello\nworld")];
    expect(projectContextMessages(input).messages).toEqual(input);
  });

  test("bounds by character and line thresholds with literal head/tail and recovery handle", () => {
    const text = Array.from({ length: 900 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    const result = projectContextMessages([tool(text)]).messages[0] as any;
    const projected = result.content[0].text as string;
    expect(projected.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_CONFIG.maxChars);
    expect(projected).toContain("line-0-");
    expect(projected).toContain("line-899-");
    expect(projected).toContain("pictx:v1:call-1:0");
  });

  test("error results receive a larger diagnostic budget", () => {
    const text = "x".repeat(20_000);
    const normal = (projectContextMessages([tool(text)]).messages[0] as any).content[0].text;
    const error = (projectContextMessages([tool(text, { isError: true })]).messages[0] as any).content[0].text;
    expect(error.length).toBeGreaterThan(normal.length);
    expect(error).toBe(text);
  });

  test("elides encoded payload and transport noise deterministically", () => {
    const encoded = "A".repeat(2000);
    const normalized = normalizeTransportNoise(`\u001b[31mred\u001b[0m\n\n\n\n\n\n{"data":"${encoded}"}`);
    expect(normalized).not.toContain("\u001b");
    expect(normalized).toContain("[encoded payload omitted: 2000 chars]");
  });

  test("stale fold is explicit and leaves recent/unfolded bytes unchanged", () => {
    const first = tool("A".repeat(10_000));
    const base = projectContextMessages([first]).messages[0] as any;
    const folded = projectContextMessages([first], { foldedToolIds: new Set(["call-1"]) }).messages[0] as any;
    expect(base.content[0].text).not.toContain("Stale tool output folded");
    expect(folded.content[0].text).toContain("Stale tool output folded");
    expect(folded.content[0].text.length).toBeLessThan(base.content[0].text.length);
  });

  test("recovery handles round-trip", () => {
    const handle = recoveryHandle("call:/ odd", 3);
    expect(parseRecoveryHandle(handle)).toEqual({ toolCallId: "call:/ odd", blockIndex: 3 });
  });

  test("image output is bounded structurally", () => {
    const message = { role: "toolResult", toolCallId: "img", content: [0, 1, 2].map((i) => ({ type: "image", data: `${i}${"x".repeat(100)}`, mimeType: "image/png" })) };
    const projected = projectContextMessages([message], { config: { ...DEFAULT_CONTEXT_CONFIG, maxImageChars: 1000 } }).messages[0] as any;
    expect(projected.content.filter((b: any) => b.type === "image")).toHaveLength(2);
    expect(projected.content.filter((b: any) => b.type === "text")).toHaveLength(1);
  });
});
