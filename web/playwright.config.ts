import { defineConfig } from "@playwright/test";

const baseURL = process.env.DEPMAP_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL, channel: "chrome", viewport: { width: 1280, height: 720 } },
  webServer: process.env.DEPMAP_BASE_URL
    ? undefined
    : { command: "pnpm exec vite --port 5173 --strictPort", url: baseURL, reuseExistingServer: true },
});
