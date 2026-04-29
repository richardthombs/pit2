/**
 * Unit tests for the org extension — pure functions and module-level helpers.
 *
 * External dependencies (@mariozechner/pi-coding-agent, @mariozechner/pi-tui)
 * are resolved to lightweight mocks via vitest.config.ts aliases.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pure utilities
import {
  fmtTokens,
  formatUsage,
  serializeFrontmatter,
  extractSection,
  type UsageStats,
} from "../../../.pi/extensions/org/utils.js";

// Module-level helpers exported from index.ts
import {
  nameToId,
  pickUnusedName,
  getFinalOutput,
  loadRoster,
  saveRoster,
  listAvailableRoles,
  loadAgentConfig,
  type JsonMessage,
  type Roster,
} from "../../../.pi/extensions/org/index.js";

// Real parseFrontmatter from the mock (yaml-backed)
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUsage(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    ...overrides,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pit2-test-"));
}

// ─── fmtTokens ────────────────────────────────────────────────────────────────

describe("fmtTokens", () => {
  it("returns raw number for 0", () => {
    expect(fmtTokens(0)).toBe("0");
  });

  it("returns raw number for 1", () => {
    expect(fmtTokens(1)).toBe("1");
  });

  it("returns raw number for 999", () => {
    expect(fmtTokens(999)).toBe("999");
  });

  it("formats 1000 as 1.0k", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
  });

  it("formats 1500 as 1.5k", () => {
    expect(fmtTokens(1500)).toBe("1.5k");
  });

  it("formats 9999 as 9.9k", () => {
    expect(fmtTokens(9999)).toBe("9.9k");
  });

  it("formats 9950 as 9.9k (truncation, not rounding)", () => {
    // Math.floor(9950 / 100) / 10 = 9.9, not 10.0 — documents intentional truncation
    expect(fmtTokens(9950)).toBe("9.9k");
  });

  it("formats 10000 as 10k", () => {
    expect(fmtTokens(10000)).toBe("10k");
  });

  it("formats 99999 as 100k (rounded)", () => {
    expect(fmtTokens(99999)).toBe("100k");
  });

  it("formats 1000000 as 1.0M", () => {
    expect(fmtTokens(1_000_000)).toBe("1.0M");
  });

  it("formats 1500000 as 1.5M", () => {
    expect(fmtTokens(1_500_000)).toBe("1.5M");
  });
});

// ─── formatUsage ─────────────────────────────────────────────────────────────

describe("formatUsage", () => {
  it("returns empty string when all fields are zero", () => {
    expect(formatUsage(makeUsage())).toBe("");
  });

  it("shows only ↑ when only input is non-zero", () => {
    const result = formatUsage(makeUsage({ input: 1000 }));
    expect(result).toContain("↑");
    expect(result).not.toContain("↓");
    expect(result).not.toContain("$");
    expect(result).toBe("↑1.0k");
  });

  it("shows only ↓ when only output is non-zero", () => {
    const result = formatUsage(makeUsage({ output: 500 }));
    expect(result).toContain("↓");
    expect(result).not.toContain("↑");
    expect(result).not.toContain("$");
    expect(result).toBe("↓500");
  });

  it("does not show $ when cost is zero", () => {
    const result = formatUsage(makeUsage({ input: 100, output: 50, cost: 0 }));
    expect(result).not.toContain("$");
  });

  it("shows all three parts in order when all fields populated", () => {
    const result = formatUsage(makeUsage({ input: 2000, output: 1000, cost: 0.0123 }));
    expect(result).toContain("↑");
    expect(result).toContain("↓");
    expect(result).toContain("$");
    // order: ↑ before ↓ before $
    const upIdx = result.indexOf("↑");
    const downIdx = result.indexOf("↓");
    const dollarIdx = result.indexOf("$");
    expect(upIdx).toBeLessThan(downIdx);
    expect(downIdx).toBeLessThan(dollarIdx);
    expect(result).toBe("↑2.0k ↓1.0k $0.0123");
  });

  it("rounds cost to 4 decimal places", () => {
    const result = formatUsage(makeUsage({ cost: 0.000056789 }));
    expect(result).toBe("$0.0001");
  });

  it("shows cost with exactly 4 decimal places", () => {
    const result = formatUsage(makeUsage({ cost: 1.5 }));
    expect(result).toBe("$1.5000");
  });
});

// ─── serializeFrontmatter ─────────────────────────────────────────────────────

describe("serializeFrontmatter", () => {
  it("serializes simple string values without quotes", () => {
    const out = serializeFrontmatter({ name: "Casey Kim", status: "planning" }, "");
    expect(out).toContain("name: Casey Kim");
    expect(out).toContain("status: planning");
  });

  it("quotes strings containing a colon", () => {
    const out = serializeFrontmatter({ title: "Foo: Bar" }, "");
    expect(out).toContain(`title: "Foo: Bar"`);
  });

  it("quotes strings containing a hash", () => {
    const out = serializeFrontmatter({ label: "feature #1" }, "");
    expect(out).toContain(`label: "feature #1"`);
  });

  it("quotes strings that start with a space", () => {
    const out = serializeFrontmatter({ note: " leading space" }, "");
    expect(out).toContain(`note: " leading space"`);
  });

  it("serializes null as 'null'", () => {
    const out = serializeFrontmatter({ owner: null }, "");
    expect(out).toContain("owner: null");
  });

  it("serializes undefined as 'null'", () => {
    const out = serializeFrontmatter({ owner: undefined }, "");
    expect(out).toContain("owner: null");
  });

  it("serializes number and boolean values without quotes", () => {
    const out = serializeFrontmatter({ count: 42, active: true, ratio: 0.5 }, "");
    expect(out).toContain("count: 42");
    expect(out).toContain("active: true");
    expect(out).toContain("ratio: 0.5");
  });

  it("serializes an empty array as '[]'", () => {
    const out = serializeFrontmatter({ tags: [] }, "");
    expect(out).toContain("tags: []");
  });

  it("serializes a non-empty array as multi-line with '  - ' prefix", () => {
    const out = serializeFrontmatter({ tags: ["a", "b"] }, "");
    expect(out).toContain("tags:");
    expect(out).toContain('  - "a"');
    expect(out).toContain('  - "b"');
  });

  it("wraps output with --- delimiters", () => {
    const out = serializeFrontmatter({ x: "y" }, "");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("\n---\n");
  });

  it("preserves body content unchanged after the closing ---", () => {
    const body = "## Objective\n\nDo the thing.\n\n## Details\n\nMore here.";
    const out = serializeFrontmatter({ status: "ready" }, body);
    expect(out.endsWith(body)).toBe(true);
  });

  it("round-trip: parse then serialize is stable", () => {
    // Build a doc, parse it, re-serialize, parse again — second parse should match first.
    const original = serializeFrontmatter(
      { status: "planning", assignee: "Casey Kim", notes: null, tags: ["alpha", "beta"] },
      "Some body text.",
    );
    const { frontmatter: fm1, body: b1 } = parseFrontmatter<Record<string, unknown>>(original);
    const reserialized = serializeFrontmatter(fm1, b1);
    const { frontmatter: fm2, body: b2 } = parseFrontmatter<Record<string, unknown>>(reserialized);
    expect(b1).toBe(b2);
    expect(fm2.status).toBe(fm1.status);
    expect(fm2.assignee).toBe(fm1.assignee);
    // null fields may not survive the yaml round-trip as null — only check body equality
  });
});

// ─── extractSection ───────────────────────────────────────────────────────────

describe("extractSection", () => {
  const doc = [
    "## Objective",
    "",
    "Build the thing.",
    "",
    "## Background",
    "",
    "It needs to be built because reasons.",
    "",
    "## Last Section",
    "",
    "No following heading here.",
  ].join("\n");

  it("extracts the body of a named section", () => {
    const result = extractSection(doc, "Objective");
    expect(result).toBe("Build the thing.");
  });

  it("stops at the next ## heading", () => {
    const result = extractSection(doc, "Background");
    expect(result).not.toContain("Last Section");
    expect(result).toBe("It needs to be built because reasons.");
  });

  it("works on the last section (no following heading)", () => {
    const result = extractSection(doc, "Last Section");
    expect(result).toBe("No following heading here.");
  });

  it("returns empty string when section is not found", () => {
    expect(extractSection(doc, "Nonexistent")).toBe("");
  });
});

// ─── nameToId ────────────────────────────────────────────────────────────────

describe("nameToId", () => {
  it("lowercases and hyphenates a plain name", () => {
    expect(nameToId("Casey Kim")).toBe("casey-kim");
  });

  it("strips apostrophes", () => {
    expect(nameToId("Blake O'Brien")).toBe("blake-obrien");
  });

  it("strips non-ASCII characters", () => {
    // ö is stripped; result should be "zion-bergstrm"
    expect(nameToId("Zion Bergström")).toBe("zion-bergstrm");
  });
});

// ─── pickUnusedName ──────────────────────────────────────────────────────────

describe("pickUnusedName", () => {
  it("returns a name not in the used list", () => {
    const result = pickUnusedName(["Casey Kim"]);
    expect(result).not.toBeNull();
    expect(result).not.toBe("Casey Kim");
  });

  it("never returns a name that is in the used list", () => {
    const used = ["Casey Kim", "Sam Chen", "Jordan Blake"];
    for (let i = 0; i < 20; i++) {
      const result = pickUnusedName(used);
      if (result !== null) {
        expect(used).not.toContain(result);
      }
    }
  });

  it("returns null when all names are used", () => {
    // Build a list containing every name in the pool by exhausting picks
    const used: string[] = [];
    let pick = pickUnusedName(used);
    while (pick !== null) {
      used.push(pick);
      pick = pickUnusedName(used);
    }
    expect(pickUnusedName(used)).toBeNull();
  });
});

// ─── getFinalOutput ───────────────────────────────────────────────────────────

describe("getFinalOutput", () => {
  it("returns empty string when messages array is empty", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("returns empty string when no assistant messages present", () => {
    const msgs: JsonMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    expect(getFinalOutput(msgs)).toBe("");
  });

  it("returns the text from a single assistant message", () => {
    const msgs: JsonMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    expect(getFinalOutput(msgs)).toBe("Done.");
  });

  it("returns the LAST assistant message's text when multiple exist", () => {
    const msgs: JsonMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "First response." }] },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
      { role: "assistant", content: [{ type: "text", text: "Second response." }] },
    ];
    expect(getFinalOutput(msgs)).toBe("Second response.");
  });

  it("skips non-assistant messages (tool results, user messages)", () => {
    const msgs: JsonMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Before tool." }] },
      { role: "tool", content: [{ type: "tool_result", text: "tool output" }] },
      { role: "user", content: [{ type: "text", text: "User follow-up" }] },
    ];
    // No trailing assistant message — should return the assistant one
    expect(getFinalOutput(msgs)).toBe("Before tool.");
  });

  it("skips assistant content blocks that are not text type", () => {
    const msgs: JsonMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use" },
          { type: "text", text: "Final text." },
        ],
      },
    ];
    expect(getFinalOutput(msgs)).toBe("Final text.");
  });

  it("skips assistant content blocks with empty-string text", () => {
    const msgs: JsonMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ];
    expect(getFinalOutput(msgs)).toBe("");
  });
});

// ─── loadRoster / saveRoster ──────────────────────────────────────────────────

describe("loadRoster", () => {
  it("returns an empty roster when the file does not exist", () => {
    const tmpDir = makeTmpDir();
    const roster = loadRoster(tmpDir);
    expect(roster).toEqual({ members: [], usedNames: [] });
  });

  it("returns an empty roster when the file contains invalid JSON", () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".pi", "roster.json"), "not json");
    const roster = loadRoster(tmpDir);
    expect(roster).toEqual({ members: [], usedNames: [] });
  });

  it("returns an empty roster when the file contains {} (missing fields normalised to empty arrays)", () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".pi", "roster.json"), "{}");
    const roster = loadRoster(tmpDir);
    expect(roster).toEqual({ members: [], usedNames: [] });
  });
});

describe("saveRoster / loadRoster round-trip", () => {
  let tmpDir: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save then load returns the same data", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });

    const roster: Roster = {
      members: [
        { id: "casey-kim", name: "Casey Kim", role: "typescript-engineer", hiredAt: "2024-01-01T00:00:00.000Z" },
      ],
      usedNames: ["Casey Kim"],
    };

    await saveRoster(tmpDir, roster);
    const loaded = loadRoster(tmpDir);
    expect(loaded).toEqual(roster);
  });

  it("overwrites existing data on subsequent saves", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });

    const first: Roster = { members: [], usedNames: ["Alex Rivera"] };
    const second: Roster = {
      members: [{ id: "alex-rivera", name: "Alex Rivera", role: "qa-engineer", hiredAt: "2024-01-01T00:00:00.000Z" }],
      usedNames: ["Alex Rivera"],
    };

    await saveRoster(tmpDir, first);
    await saveRoster(tmpDir, second);
    const loaded = loadRoster(tmpDir);
    expect(loaded).toEqual(second);
  });
});

// ─── listAvailableRoles ──────────────────────────────────────────────────────

describe("listAvailableRoles", () => {
  let tmpDir: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array when the agents dir does not exist", () => {
    tmpDir = makeTmpDir();
    // No .pi/agents/ created
    expect(listAvailableRoles(tmpDir)).toEqual([]);
  });

  it("returns role names without the .md extension", () => {
    tmpDir = makeTmpDir();
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "typescript-engineer.md"), "content");
    fs.writeFileSync(path.join(agentsDir, "qa-engineer.md"), "content");
    fs.writeFileSync(path.join(agentsDir, "not-a-role.txt"), "content"); // should be ignored

    const roles = listAvailableRoles(tmpDir);
    expect(roles).toContain("typescript-engineer");
    expect(roles).toContain("qa-engineer");
    expect(roles).not.toContain("not-a-role.txt");
    expect(roles).not.toContain("typescript-engineer.md");
  });
});

// ─── loadAgentConfig ─────────────────────────────────────────────────────────

describe("loadAgentConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the role file does not exist", () => {
    tmpDir = makeTmpDir();
    expect(loadAgentConfig(tmpDir, "nonexistent-role")).toBeNull();
  });

  it("returns a parsed config for a valid role file", () => {
    tmpDir = makeTmpDir();
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "typescript-engineer.md"),
      [
        "---",
        "name: TypeScript Engineer",
        "description: Writes TypeScript code",
        "---",
        "",
        "You are a TypeScript engineer.",
      ].join("\n"),
    );

    const config = loadAgentConfig(tmpDir, "typescript-engineer");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("TypeScript Engineer");
    expect(config!.description).toBe("Writes TypeScript code");
    expect(config!.systemPrompt).toContain("TypeScript engineer");
  });

  it("returns null when the file is missing required fields", () => {
    tmpDir = makeTmpDir();
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    // Missing 'description'
    fs.writeFileSync(
      path.join(agentsDir, "incomplete.md"),
      ["---", "name: Incomplete", "---", "", "Body."].join("\n"),
    );
    expect(loadAgentConfig(tmpDir, "incomplete")).toBeNull();
  });
});
