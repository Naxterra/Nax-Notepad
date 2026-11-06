import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  workers: 3,
  use: { baseURL: "http://127.0.0.1:1425", headless: true },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1425",
    url: "http://127.0.0.1:1425/tests/ui/fixture.html",
    reuseExistingServer: false,
  },
});
