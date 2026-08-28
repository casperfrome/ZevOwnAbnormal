const { chromium: browserType } = require('playwright');

// Use Playwright's bundled browser unless a local executable is explicitly selected.
const chromium = {
  launch(options = {}) {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    return browserType.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      ...options,
    });
  },
};

module.exports = { chromium };
