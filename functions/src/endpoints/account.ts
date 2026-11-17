// SPDX-License-Identifier: Apache-2.0
// An account's own records: deleting forever, personal access tokens and teams (SPEC §2, §4, §18, §19).

import { onRequest } from "firebase-functions/v2/https";
import * as cookie from "cookie";
import {
  freshReceiptId,
  readReceipt,
  recordReceipt,
  clearReceipt,
} from "../lib/transaction-receipts";
import {
  SESSION_COOKIE_NAME,
  PURGE_CODE_TTL_MS,
  TRASH_RETENTION_MS,
  publicOrigin,
} from "../config";
import { verifySessionCookie } from "../lib/auth";
import { describePurge, inOwnTrash, purgeOwn, type PurgeSummary } from "../lib/purge";
import {
  checkPurgeCode,
  maskAddress,
  parseTarget,
  reservePurgeCode,
  retirePurgeCode,
  targetKey,
} from "../lib/purgecode";
import { emailEnabled } from "../email/send";
import { isAllowedEmail } from "../generated/policy";
import { canManageTeam, type TeamAclData } from "../lib/acl";
import { normalizeEmail } from "../lib/access";
import { resolveCaller } from "../lib/actor";
import { refanTeam, slugify } from "../lib/folders";
import { computeTeamMembers } from "../lib/teams";
import {
  bearerFrom,
  isTokenShaped,
  listTokens,
  mintToken,
  revokeToken,
  verifyToken,
  type TokenChannel,
} from "../lib/tokens";
import { badRequest, jsonBody, noStore, rejectMethod, safeSegment } from "../lib/http";
// Types only: email/notify loads React and the templates, so the three paths
// that send import it where they send, and no cold start pays for it (ADR 0008).
import type { InviteTarget } from "../email/notify";
import { db, now, MAILING, PLAIN } from "./runtime";
import { asArray } from "./sharing";
import { sixDigitCode } from "./verification";

// ---------------------------------------------------------------------------
// Deleting forever (SPEC §4, ADR 0025)
// ---------------------------------------------------------------------------

const PURGE_FROM_BROWSER_ONLY =
  "Deleting forever is done in the browser, with a code sent to the account's email. An agent can move things to the Trash and back, never delete them.";

/** What a code deletes, as the object of a sentence in its email. */
function purgeObject(s: PurgeSummary): string {
  const n = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);
  if (s.kind === "document") return s.versions > 1 ? `“${s.title}” and its ${s.versions} versions` : `“${s.title}”`;
  if (s.kind === "folder") {
    return s.documents > 0 ? `the folder “${s.title}” and ${n(s.documents, "document", "documents")} of yours in it` : `the folder “${s.title}”`;
  }
  return `everything in your Trash (${n(s.documents, "document", "documents")} and ${n(s.folders, "folder", "folders")})`;
}

/**
 * GET /purge and POST /purge — deleting from the Trash forever, early.
 *
 * GET answers whether it is possible here, `{ available, retentionDays }`:
 * only where email is on, because the code has to arrive. POST
 * `{ op: "code", target }` emails a code for exactly that target, one item
 * (`{ kind, id }`) or everything (`{ all: true }`), and answers what it will
 * delete and where the code went; `{ op: "confirm", target, code }` spends the
 * code and deletes, answering how many folders and documents went.
 *
 * The browser's session only. A token, whoever's, is refused: deleting
 * forever is the one thing an agent may not do for its person, and a token is
 * a credential that may be on a server nobody watches. Only the caller's own
 * items go; what went with their folder but is someone else's stays in that
 * person's Trash (lib/purge.ts).
 */
export const purgeTrash = onRequest(MAILING, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  if (req.method === "GET") {
    res.status(200).json({ available: emailEnabled(), retentionDays: Math.round(TRASH_RETENTION_MS / 86_400_000) });
    return;
  }
  const session = cookie.parse(req.headers.cookie || "")[SESSION_COOKIE_NAME];
  const caller = session ? await verifySessionCookie(session) : null;
  if (!caller) {
    if (bearerFrom(req.headers.authorization)) res.status(403).json({ error: PURGE_FROM_BROWSER_ONLY });
    else res.status(401).end();
    return;
  }
  const body = jsonBody(req) as { op?: unknown; target?: unknown; code?: unknown } | null;
  const op = body?.op === "code" || body?.op === "confirm" ? body.op : null;
  const target = parseTarget(body?.target);
  if (!op || !target) {
    badRequest(res, 'expected { op: "code" | "confirm", target: { kind, id } | { all: true } }');
    return;
  }
  if (!emailEnabled()) {
    res.status(409).json({ error: "Email is off here, so nothing can be deleted early: the Trash deletes each item 30 days after it arrived.", emailOff: true });
    return;
  }
  const key = targetKey(target);
  const notInTrash = () => res.status(404).json({ error: "that is not in your Trash" });

  if (op === "code") {
    const summary = await describePurge(db(), caller.uid, target);
    if (!summary) {
      notInTrash();
      return;
    }
    const code = sixDigitCode();
    if ((await reservePurgeCode(db(), caller.uid, key, code)) === "cooldown") {
      res.status(429).json({ error: "a code was just sent; wait a minute before asking for another" });
      return;
    }
    const minutes = Math.round(PURGE_CODE_TTL_MS / 60000);
    const { sendPurgeCode } = await import("../email/notify");
    const sent = await sendPurgeCode(caller.emailLower, code, minutes, purgeObject(summary));
    if (!sent) {
      res.status(502).json({ error: "the code could not be sent; try again in a minute" });
      return;
    }
    res.status(200).json({ sentTo: maskAddress(caller.emailLower), expiresInMinutes: minutes, summary });
    return;
  }

  if (!(await inOwnTrash(db(), caller.uid, target))) {
    notInTrash();
    return;
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const checked = await checkPurgeCode(db(), caller.uid, key, code);
  if (checked.status !== 200) {
    res.status(checked.status).json({ error: checked.error });
    return;
  }
  const out = await purgeOwn(db(), caller.uid, target);
  await retirePurgeCode(db(), caller.uid);
  res.status(200).json(out);
});

// ---------------------------------------------------------------------------
// Personal access tokens
// ---------------------------------------------------------------------------

/**
 * POST /tokens — `{ op: "create" | "revoke" | "list", ... }`.
 *
 * A token carries exactly its owner's identity and therefore exactly their ACL.
 * No service accounts, no impersonation, no second permission model to reason
 * about: a token can do what its owner can do and nothing more.
 */
export const manageTokens = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const body = jsonBody(req) as {
    op?: unknown;
    name?: unknown;
    channel?: unknown;
    tokenId?: unknown;
  } | null;
  const op = body?.op;

  // Session-only, with one exception. Minting a credential with a credential is
  // how a leaked token becomes permanent access, and listing would show a
  // stolen token every other one. Revoking ITSELF can only shrink access: a
  // leaked token used that way ends itself and nothing else. It is how
  // `bikeshed logout` signs a computer out on the server too (SPEC §23).
  const cookieHeader = cookie.parse(req.headers.cookie || "")[SESSION_COOKIE_NAME];
  const caller = cookieHeader ? await verifySessionCookie(cookieHeader) : null;
  if (!caller) {
    const bearer = bearerFrom(req.headers.authorization);
    const presented =
      op === "revoke" && isTokenShaped(bearer) ? await verifyToken(db(), bearer as string) : null;
    if (!presented) {
      res.status(401).end();
      return;
    }
    if (body?.tokenId !== undefined && body.tokenId !== presented.tokenId) {
      res.status(403).json({ error: "A token can revoke only itself." });
      return;
    }
    const ok = await revokeToken(db(), presented.uid, presented.tokenId);
    res.status(ok ? 200 : 404).json({ revoked: ok });
    return;
  }

  if (op === "list") {
    res.status(200).json({ tokens: await listTokens(db(), caller.uid) });
    return;
  }

  if (op === "create") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      badRequest(res, "name is required — an unnamed token cannot be revoked with confidence");
      return;
    }
    const channel: TokenChannel =
      body?.channel === "cli" || body?.channel === "mcp" ? body.channel : "api";
    const minted = await mintToken(db(), caller.uid, caller.emailLower, name, channel);
    // Shown once. There is no second chance by design.
    res.status(200).json({ tokenId: minted.tokenId, token: minted.plaintext });
    return;
  }

  if (op === "revoke") {
    const tokenId = typeof body?.tokenId === "string" ? body.tokenId : "";
    if (!tokenId) {
      badRequest(res, "tokenId is required");
      return;
    }
    const ok = await revokeToken(db(), caller.uid, tokenId);
    res.status(ok ? 200 : 404).json({ revoked: ok });
    return;
  }

  badRequest(res, 'op must be "create", "revoke" or "list"');
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------


/** POST /team — `{ op: "create" | "rename" | "delete", teamId?, name? }`. */
export const manageTeam = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    op?: unknown;
    teamId?: unknown;
    name?: unknown;
  } | null;
  const op = body?.op;

  if (op === "create") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      badRequest(res, "team name is required (up to 120 characters)");
      return;
    }
    const ref = db().collection("teams").doc();
    await ref.set({
      teamId: ref.id,
      name,
      slug: slugify(name),
      ownerEmail: caller.emailLower,
      admins: [caller.emailLower],
      members: [caller.emailLower],
      createdAt: now(),
      updatedAt: now(),
    });
    res.status(200).json({ teamId: ref.id, name });
    return;
  }

  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  if (!teamId || !safeSegment(teamId)) {
    badRequest(res, "invalid or missing teamId");
    return;
  }
  const ref = db().collection("teams").doc(teamId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  if (!canManageTeam(snap.data() as TeamAclData, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  if (op === "rename") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      badRequest(res, "team name is required (up to 120 characters)");
      return;
    }
    await ref.set({ name, slug: slugify(name), updatedAt: now() }, { merge: true });
    res.status(200).json({ ok: true });
    return;
  }

  if (op === "delete") {
    await ref.delete();
    // Grants naming the team survive as dangling references and expand to
    // nothing, which DENIES. Re-fanning here is what turns that from a latent
    // inconsistency into an immediate, correct revocation.
    const affected = await refanTeam(db(), teamId);
    res.status(200).json({ ok: true, affected });
    return;
  }

  badRequest(res, 'op must be "create", "rename" or "delete"');
});

/** POST /team-members — `{ teamId, add?: string[], remove?: string[], admin?: {...} }`. */
export const manageTeamMembers = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    teamId?: unknown;
    add?: unknown;
    remove?: unknown;
    admin?: unknown;
  } | null;
  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  if (!teamId || !safeSegment(teamId)) {
    badRequest(res, "invalid or missing teamId");
    return;
  }

  const add = Array.isArray(body?.add) ? (body.add as unknown[]).map(String) : [];
  const remove = Array.isArray(body?.remove)
    ? (body.remove as unknown[]).map(String)
    : [];
  const badEmails = add.map(normalizeEmail).filter((e) => !isAllowedEmail(e));
  if (badEmails.length > 0) {
    badRequest(res, `not a valid recipient: ${badEmails.join(", ")}`);
    return;
  }

  const ref = db().collection("teams").doc(teamId);
  const receipt = freshReceiptId();
  type TeamChange = { status: 200; team: { name: string }; before: string[]; members: string[]; admins: string[] };
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const completed = readReceipt<TeamChange>(snap, receipt);
    if (completed.found) return completed.result;
    if (!snap.exists) {
      return { status: 404 as const };
    }
    const team = snap.data() as TeamAclData & { name?: string; members?: unknown };
    if (!canManageTeam(team, caller.emailLower)) {
      return { status: 403 as const };
    }

    const before = asArray(team.members);
    const set = new Set(before);
    for (const e of remove.map(normalizeEmail)) {
      // The owner is never removed: a team with no owner has no one who can fix it.
      if (e && e !== String(team.ownerEmail || "").toLowerCase()) set.delete(e);
    }
    for (const e of add.map(normalizeEmail)) if (e) set.add(e);
    const members = computeTeamMembers(String(team.ownerEmail || ""), [...set]);

    let admins = asArray(team.admins).filter((email) => members.includes(email));
    if (body?.admin && typeof body.admin === "object") {
      const a = body.admin as { email?: unknown; isAdmin?: unknown };
      const email = normalizeEmail(typeof a.email === "string" ? a.email : "");
      if (email && members.includes(email)) {
        const adminSet = new Set(admins);
        if (a.isAdmin === true) adminSet.add(email);
        else if (email !== String(team.ownerEmail || "").toLowerCase()) adminSet.delete(email);
        admins = [...adminSet].sort();
      }
    }

    tx.set(ref, { members, admins, updatedAt: now() }, { merge: true });
    const completedChange: TeamChange = { status: 200, team: { name: typeof team.name === "string" ? team.name : "a team" }, before, members, admins };
    recordReceipt(tx, ref, snap, receipt, completedChange);
    return completedChange;
  });
  if (result.status !== 200) { res.status(result.status).end(); return; }
  await clearReceipt(ref, receipt);
  const { team, before, members, admins } = result;

  // Removing someone from a team must revoke their access everywhere the team
  // was granted, and adding someone must grant it. Both are the same recompute.
  const affected = await refanTeam(db(), teamId);

  const beforeSet = new Set(before);
  const invitees: InviteTarget[] = members
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: "viewer" as const }));
  if (invitees.length > 0) {
    // A branch of the invitation template, not a fourth message type: being
    // added to a team silently grants access to everything that team holds,
    // which is the same silence the invitation exists to break.
    const { sendInvitations } = await import("../email/notify");
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof team.name === "string" ? team.name : "a team",
      kind: "team",
      url: `${publicOrigin()}/account`,
    });
  }

  res.status(200).json({ members, admins, affected });
});
