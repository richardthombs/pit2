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


