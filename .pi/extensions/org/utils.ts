/**
 * Pure utility functions for the org extension.
 * No pi-runtime imports — safe to test in isolation.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;           // USD, summed across turns
	contextTokens: number;  // from last turn — overwrite, not sum
}

// ─── Token formatting ─────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
	if (n < 1000)    return String(n);
	if (n < 10000)   return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

export function formatUsage(u: UsageStats): string {
	const parts: string[] = [];
	if (u.input)    parts.push(`↑${fmtTokens(u.input)}`);
	if (u.output)   parts.push(`↓${fmtTokens(u.output)}`);
	if (u.cost > 0) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

// ─── Memory helpers (pure — no pi-runtime deps) ───────────────────────────────

export const MEMORY_DIR = "memory";
export const VALID_MEMORY_SECTIONS = [
	"Conventions",
	"Decisions",
	"Pitfalls",
	"EM Preferences",
	"Codebase Landmarks",
	"Miscellaneous",
];
export const MAX_MEMORY_ITEMS_PER_SECTION = 10;

export function extractMemoryEntries(output: string): {
	entries: { section: string; entry: string }[];
	cleanOutput: string;
} {
	const entries: { section: string; entry: string }[] = [];
	const cleanOutput = output
		.replace(
			/<!--\s*MEMORY\s*\nsection:\s*([^\n]+)\nentry:\s*([^\n]+)\s*-->/g,
			(_, section, entry) => {
				const s = section.trim();
				const e = entry.trim();
				if (VALID_MEMORY_SECTIONS.includes(s) && e) {
					entries.push({ section: s, entry: e });
					return "";
				}
				// Unknown section or empty entry — leave block in output unchanged
				return _;
			},
		)
		.trim();
	return { entries, cleanOutput };
}

