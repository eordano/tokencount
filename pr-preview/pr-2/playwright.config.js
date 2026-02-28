import { defineConfig } from "@playwright/test";
import { execSync } from "child_process";

// Resolve chromium path: BROWSER_PATH env, or nix-provided chromium
let chromiumPath;
if (process.env.BROWSER_PATH) {
  chromiumPath = process.env.BROWSER_PATH;
} else {
  try {
    chromiumPath = execSync('nix-shell -p chromium --run "which chromium" 2>/dev/null')
      .toString()
      .trim();
  } catch {
    chromiumPath = "/usr/bin/chromium";
  }
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.js",
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: "http://localhost:8000",
    screenshot: "off",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          executablePath: chromiumPath,
          args: ["--no-sandbox"],
        },
      },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
        isMobile: true,
        launchOptions: {
          executablePath: chromiumPath,
          args: ["--no-sandbox"],
        },
      },
    },
  ],
  webServer: {
    command: "python3 -m http.server 8000",
    port: 8000,
    reuseExistingServer: true,
  },
});
