// SPDX-License-Identifier: Apache-2.0
// New documents inherit their owner's export default across publishing channels, while an explicit choice wins (SPEC §20).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { publishNewDocument } = require("../lib/lib/publish.js");

const owner = { uid: "owner", email: "owner@example.com" };
const on = { enabled: true, label: "Account default", footer: "For review" };
const off = { enabled: false, label: "", footer: "" };

test("MCP and CLI publications inherit the saved account default; explicit off, custom marking and missing accounts stay distinct", async () => {
  const saved = ["storage", "database"].map((key) => [key, Object.getOwnPropertyDescriptor(admin, key)]);
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ file: () => ({ save: async () => {} }) }) }) });
  Object.defineProperty(admin, "database", { configurable: true, value: () => { throw new Error("not configured"); } });
  try {
    for (const [via, account, marking, expected] of [
      ["mcp", on, undefined, on],
      ["cli", on, undefined, on],
      ["upload", on, off, off],
      ["mcp", on, { enabled: true, label: "Explicit", footer: "Chosen" }, { enabled: true, label: "Explicit", footer: "Chosen" }],
      ["cli", undefined, undefined, off],
      ["mcp", off, undefined, off],
    ]) {
      const { db, store } = fakeFirestore(account ? { "users/owner": { defaultMarking: account } } : {});
      await withFakeAdmin({ db }, async () => {
        const result = await publishNewDocument({
          db, actor: { ...owner, channel: via === "upload" ? "web" : via }, ownerUid: owner.uid, ownerEmail: owner.email,
          title: "Default marking", folderId: null, parentMembership: null, via, ...(marking === undefined ? {} : { marking }),
          compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from("<p>content</p>") }] },
        });
        assert.deepEqual(store.get(`docs/${result.docId}`).marking, expected, `${via}: absent marking inherits, explicit marking wins`);
      });
    }
    // The upload route is also the CLI route: an absent query parameter must
    // reach publishNewDocument as absent, not jsonParam's null sentinel.
    const { createDoc } = require("../lib/index.js");
    for (const [marking, expected] of [[undefined, on], [off, off]]) {
      const { db, store } = fakeFirestore({ "users/owner": { defaultMarking: on } });
      await withFakeAdmin({ db, sessions: { s: { uid: owner.uid, email: owner.email, email_verified: true } } }, async () => {
        const body = Buffer.from("<!DOCTYPE html><html><body><p>CLI publication.</p></body></html>");
        const response = await invoke(createDoc, {
          headers: { cookie: "__session=s", "content-type": "application/octet-stream" },
          query: { filename: "index.html", ...(marking === undefined ? {} : { marking: JSON.stringify(marking) }) },
          rawBody: body, body,
        });
        assert.equal(response.status, 200, "the CLI publication route succeeds");
        assert.deepEqual(store.get(`docs/${response.body.docId}`).marking, expected, "CLI upload preserves absent marking and explicit off");
      });
    }
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(admin, key, descriptor); else delete admin[key]; }
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
});
