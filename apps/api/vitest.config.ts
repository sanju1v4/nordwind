import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    // Load E:\Nordwind\.env so tests use the same database settings as the API.
    env: loadEnv("test", "../../", ""),
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000, // a cloud database (Neon) can be slow to wake up
    fileParallelism: false,
  },
});
