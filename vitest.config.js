import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.js"],
    coverage: {
      provider: "v8",
      include: ["background/**/*.js", "content-scripts/**/*.js"],
    },
  },
});
