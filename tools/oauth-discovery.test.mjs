// SPDX-License-Identifier: Apache-2.0
// Public OAuth entry points stay relative and the documentation shortcuts retain their exact destinations (SPEC §19, §23).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
test("the MCP manifest uses only relative deployment addresses", () => {
  const manifest = readJson("../app/public/.well-known/mcp.json");
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(manifest);
  assert.deepEqual(strings.filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//")), []);
  assert.equal(manifest.transport.url, "/mcp");
  assert.equal(manifest.authentication.resourceMetadata, "/.well-known/oauth-protected-resource/mcp");
  assert.equal(manifest.authentication.authorizationServer, "/.well-known/oauth-authorization-server");
  assert.equal(manifest.authentication.instructions, "/llms.txt");
});
test("the docs shortcuts preserve the documentation document each route names", () => {
  const redirects = readJson("../firebase.json").hosting.redirects;
  for (const [source, destination] of [["/docs", "/d/docs"], ["/docs/", "/d/docs"], ["/docs/developers", "/d/docs-developers"]]) {
    assert.deepEqual(redirects.find((entry) => entry.source === source), { source, destination, type: 302 });
  }
});
