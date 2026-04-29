/**
 * Minimal mock for @mariozechner/pi-tui.
 * Only truncateToWidth is used in the extension — return the string unchanged
 * for test purposes.
 */
export const truncateToWidth = (s: string, _width: number): string => s;
