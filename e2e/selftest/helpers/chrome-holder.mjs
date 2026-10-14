// SPDX-License-Identifier: Apache-2.0
// Self-test helper: a spec-like process that holds a Chrome, launched the harness's way or not, until it is signalled (SPEC §12).

/**
 *   node chrome-holder.mjs <pool|launch|plain>
 *
 *   pool    a BrowserPool with one user (context and page), as a case makes
 *   launch  launchChrome() alone
 *   plain   Playwright's chromium.launch without the mark switch (what the
 *           harness never does): the negative control's browser
 *
 * Prints "ready <pid> <browser mark>" once Chrome is up, then idles. A run's
 * identity, if any, comes in E2E_RUN_OWNER, as run.mjs gives it to specs.
 */

import { chromium } from "playwright-core";
import { BrowserPool, CHROME_ARGS, launchChrome } from "../../lib/browser.mjs";
import { browserMark } from "../../lib/browsers.mjs";

const mode = process.argv[2];
if (mode === "pool") {
  const target = { kind: "local", runId: "selftest-holder", origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: 9 } } };
  const pool = new BrowserPool({ target });
  await pool.user();
} else if (mode === "launch") {
  await launchChrome();
} else if (mode === "plain") {
  await chromium.launch({ channel: "chrome", headless: true, args: [...CHROME_ARGS] });
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.stdout.write(`ready ${process.pid} ${browserMark()}\n`);
setInterval(() => {}, 1000);
