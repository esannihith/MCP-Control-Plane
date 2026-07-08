import { describe, expect, it } from "vitest";
import { exposedToolName, MAX_TOOL_NAME_LENGTH, sanitizeNamePart } from "../src/upstream/naming.js";

const none = new Set<string>();

describe("sanitizeNamePart", () => {
  it("keeps allowed characters and replaces the rest", () => {
    expect(sanitizeNamePart("gmail")).toBe("gmail");
    expect(sanitizeNamePart("my server!v2")).toBe("my_server_v2");
    expect(sanitizeNamePart("do.thing")).toBe("do_thing");
  });

  it("never returns an empty string", () => {
    expect(sanitizeNamePart("")).toBe("x");
    expect(sanitizeNamePart("!!!")).toBe("___");
  });
});

describe("exposedToolName", () => {
  it("joins upstream and tool names", () => {
    expect(exposedToolName("gmail", "search_threads", none)).toBe("gmail_search_threads");
  });

  it("caps long names at the limit with a deterministic hash suffix", () => {
    const long = "a-very-long-tool-name-that-goes-on-and-on-and-on-forever-really";
    const first = exposedToolName("my-long-upstream-name", long, none);
    const second = exposedToolName("my-long-upstream-name", long, none);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(first).toBe(second);
    expect(first).toMatch(/_[0-9a-f]{8}$/);
  });

  it("resolves collisions with a hash suffix", () => {
    const taken = new Set([exposedToolName("srv", "tool", none)]);
    const second = exposedToolName("srv", "tool", taken);
    expect(second).not.toBe("srv_tool");
    expect(second.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it("distinguishes tools that sanitize identically", () => {
    const first = exposedToolName("srv", "do.thing", none);
    const second = exposedToolName("srv", "do_thing", new Set([first]));
    expect(first).toBe("srv_do_thing");
    expect(second).not.toBe(first);
  });
});
