// SPDX-License-Identifier: Apache-2.0
// Email is optional, bounded, and never renders a comment as markup (SPEC §14).

const test = require("node:test");
const assert = require("node:assert/strict");

const { sendEmail, documentUrl } = require("../lib/email/send.js");
const { inviteText } = require("../lib/email/templates/Invite.js");
const { verifyText } = require("../lib/email/templates/Verify.js");
const { commentNoticeText } = require("../lib/email/templates/CommentNotice.js");

/**
 * The unconfigured path is the one CI exercises, deliberately. A configured
 * Resend key gets manual attention the first time somebody sets it up; the
 * no-key path is the one that has to keep working silently forever, and it is
 * what makes the quickstart runnable without an email account.
 */
test("with no API key every send is a clean, logged no-op", async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const logged = [];
  const info = console.info;
  console.info = (line) => logged.push(line);
  try {
    const result = await sendEmail({
      to: "a@example.com",
      subject: "Subject",
      body: null,
      text: "text",
    });
    assert.deepEqual(result, { sent: false, reason: "no_api_key" });
    assert.equal(logged.length, 1, "a skipped send is logged, not silent");
    assert.match(logged[0], /skipped/);
    assert.match(logged[0], /a@example\.com/);
  } finally {
    console.info = info;
    if (previous !== undefined) process.env.RESEND_API_KEY = previous;
  }
});

test("a no-op send never throws, so it cannot fail its triggering request", async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const info = console.info;
  console.info = () => {};
  try {
    await assert.doesNotReject(() =>
      sendEmail({ to: "", subject: "", body: undefined, text: "" }),
    );
  } finally {
    console.info = info;
    if (previous !== undefined) process.env.RESEND_API_KEY = previous;
  }
});

test("document links are absolute and version-aware", () => {
  const previous = process.env.BIKESHED_PUBLIC_ORIGIN;
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://example.test/";
  try {
    assert.equal(documentUrl("memo"), "https://example.test/d/memo");
    assert.equal(documentUrl("memo", "v3"), "https://example.test/d/memo/v3");
  } finally {
    if (previous === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
    else process.env.BIKESHED_PUBLIC_ORIGIN = previous;
  }
});

// --- Plain-text alternatives ----------------------------------------------
// Built alongside each template rather than derived, so the two cannot drift,
// and so the comment body has somewhere to go that is text by construction.

test("the invitation text names the sharer, the thing, and the link", () => {
  const text = inviteText({
    origin: "https://example.test",
    inviterEmail: "ana@example.com",
    subjectTitle: "Q3 memo",
    kind: "document",
    role: "editor",
    url: "https://example.test/d/memo",
  });
  assert.match(text, /ana@example\.com shared "Q3 memo" with you/);
  assert.match(text, /You can edit it here/);
  assert.match(text, /https:\/\/example\.test\/d\/memo/);
});

test("a team invitation says it is a team", () => {
  const text = inviteText({
    origin: "https://example.test",
    inviterEmail: "ana@example.com",
    subjectTitle: "Design",
    kind: "team",
    role: "viewer",
    url: "https://example.test/account",
  });
  assert.match(text, /the Design team/);
});

test("the verification text carries the code and its lifetime", () => {
  const text = verifyText({ origin: "https://example.test", code: "123456", minutes: 15 });
  assert.match(text, /123456/);
  assert.match(text, /15 minutes/);
  assert.match(text, /used once/);
});

test("a comment notice quotes the anchored passage", () => {
  // The quote is what makes the message actionable: it says WHAT the comment is
  // about without the reader opening the document.
  const text = commentNoticeText({
    origin: "https://example.test",
    authorEmail: "bo@example.com",
    docTitle: "Q3 memo",
    quote: "the second paragraph",
    body: "This overstates the case.",
    url: "https://example.test/d/memo/v2",
  });
  assert.match(text, /On: "the second paragraph"/);
  assert.match(text, /This overstates the case\./);
  assert.match(text, /Reply in context/);
});

test("an automated comment is labelled as such", () => {
  const text = commentNoticeText({
    origin: "https://example.test",
    authorEmail: "bot@example.com",
    docTitle: "Q3 memo",
    quote: "x",
    body: "y",
    url: "https://example.test/d/memo",
    viaChannel: "mcp",
  });
  assert.match(text, /\(via MCP\)/);
});

test("a hostile title or body stays inert in the plain-text alternative", () => {
  // The HTML half is escaped by react-email. The text half is text, which is
  // the point: a comment body is the one place raw markup would be tempting.
  const text = commentNoticeText({
    origin: "https://example.test",
    authorEmail: "bo@example.com",
    docTitle: '<img src=x onerror=alert(1)>',
    quote: "</p><script>alert(2)</script>",
    body: "<script>alert(3)</script>",
    url: "https://example.test/d/memo",
  });
  assert.ok(text.includes("<script>alert(3)</script>"), "kept verbatim as text");
  assert.ok(!text.includes("<html"), "no markup wrapper is produced");
  assert.equal(typeof text, "string");
});
