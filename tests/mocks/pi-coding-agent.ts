/**
 * Minimal mock for @mariozechner/pi-coding-agent.
 *
 * Provides a real parseFrontmatter (using the yaml package, matching the
 * genuine implementation) and a simple passthrough withFileMutationQueue
 * that is safe to use in unit tests.
 */

import { parse } from "yaml";

export const parseFrontmatter = <T extends Record<string, unknown>>(
  content: string,
): { frontmatter: T; body: string } => {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {} as T, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {} as T, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const parsed = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string =>
  parseFrontmatter(content).body;

/** No-op queue — just runs the write function directly. */
export const withFileMutationQueue = async (
  _path: string,
  fn: () => Promise<void>,
): Promise<void> => {
  await fn();
};
