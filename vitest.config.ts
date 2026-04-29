import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "tests/mocks/pi-coding-agent.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "tests/mocks/pi-tui.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
