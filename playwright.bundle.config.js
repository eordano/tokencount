// Playwright config for testing the offline bundle (dist/tokencount.html).
// Reuses projects and settings from the base config, but serves the built bundle.
import baseConfig from "./playwright.config.js";

export default {
  ...baseConfig,
  testMatch: "workflows.spec.js",
  use: {
    ...baseConfig.use,
    baseURL: "http://localhost:8001",
  },
  webServer: {
    command:
      "cp dist/tokencount.html dist/index.html && python3 -m http.server 8001 --directory dist",
    port: 8001,
    reuseExistingServer: true,
  },
};
