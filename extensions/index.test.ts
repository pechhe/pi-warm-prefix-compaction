import { describe, expect, test } from "bun:test";
import warmPrefixCompaction from "./index.ts";

describe("warm-prefix compaction request projection", () => {
  test("authorizes the continuation request and always releases it", async () => {
    let handler: ((event: any, context: any) => Promise<any>) | undefined;
    const emitted: Array<{ name: string; value: any }> = [];
    warmPrefixCompaction({
      on(name: string, candidate: (event: any, context: any) => Promise<any>) {
        if (name === "session_before_compact") handler = candidate;
      },
      events: {
        emit(name: string, value: any) {
          emitted.push({ name, value });
        },
      },
    } as never);
    expect(handler).toBeDefined();

    const result = await handler!(
      {
        signal: new AbortController().signal,
        preparation: {
          firstKeptEntryId: "kept",
          tokensBefore: 42,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
      },
      {
        model: { provider: "openai", id: "test" },
        async completeFromLatestSettledRequest() {
          expect(emitted).toHaveLength(1);
          expect(emitted[0]?.value.action).toBe("authorize");
          return { content: [{ type: "text", text: "summary" }] };
        },
      },
    );

    expect(result.compaction.summary).toBe("summary");
    expect(emitted).toHaveLength(2);
    expect(emitted.map((event) => event.name)).toEqual([
      "pi-warm-prefix-compaction:request-projection",
      "pi-warm-prefix-compaction:request-projection",
    ]);
    expect(emitted[1]?.value).toEqual({
      action: "release",
      token: emitted[0]?.value.token,
    });
  });
});
