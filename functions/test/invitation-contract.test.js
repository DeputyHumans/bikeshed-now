// SPDX-License-Identifier: Apache-2.0
// The first share sends one invitation with the inviter, title and document link intact (SPEC §14).
const test = require('node:test');
const assert = require('node:assert/strict');
const send = require('../lib/email/send.js');
const { sendInvitations } = require('../lib/email/notify.js');
test('one new member gets exactly one correctly named and linked invitation', async () => {
  const original = send.sendEmail;
  const messages = [];
  send.sendEmail = async (message) => { messages.push(message); return { sent: true }; };
  try {
    const url = 'https://example.test/d/shared-report';
    await sendInvitations('owner@example.com', [{ email: 'reader@example.com', role: 'viewer' }], { kind: 'document', title: 'Quarterly report', url });
    assert.equal(messages.length, 1, 'one invitation per newly granted member');
    assert.equal(messages[0].subject, 'owner@example.com shared “Quarterly report” with you');
    assert.ok(messages[0].text.includes(url), 'the invitation links to the exact shared document');
  } finally { send.sendEmail = original; }
});
