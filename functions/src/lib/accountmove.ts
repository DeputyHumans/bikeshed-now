// SPDX-License-Identifier: Apache-2.0
// Moving an account to the address Google now vouches for it under (SPEC §14, ADR 0020).

/**
 * Why an account has to move at all
 * ---------------------------------
 * Firebase finds a returning Google user by Google's permanent account id and
 * never rewrites the account's own `email`. When a Workspace admin renames a
 * person, Google's tokens carry the new address while ours keep the old one,
 * and an ACL keyed by address (ADR 0004) shows them nothing shared with the
 * new one. So the account follows Google, and so does everything that names
 * the old address as a person: ownership, grants, team membership.
 *
 * Three rules keep that safe:
 * - The new address is believed only from Google's own signed token, bound to
 *   this account by `sub`, with `email_verified` true. Nothing the browser
 *   says about an address is trusted.
 * - The work runs as a job (`accountMoves/{jobId}`) that a retried trigger finishes,
 *   never inside a sign-in request: Hosting cuts those at sixty seconds.
 * - It is ordered so that a job that dies anywhere leaves nobody worse off.
 *   First the new address is added beside the old; then Firebase's own record
 *   changes, which signs the account out everywhere; then the old address is
 *   removed. A redelivery finds what is left by query and finishes it.
 *
 * History is not rewritten. A comment, a version or a change-log entry says
 * who did something at the time, and carries a uid beside the address.
 */

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { createHash, createPublicKey, verify, type KeyObject } from "crypto";
import { GRANT_LIST, ROLES, grantsOf, normalizeEmail, type Role, type RoleGrants } from "./access";
import { opensEditingToAnyAccount, type DocAclData } from "./acl";
import type { Actor } from "./actor";
import { eventActor, eventRecord } from "./events";
import { membershipOf, persistDocMembership, recomputeSubtree, refanTeam } from "./folders";
import { syncPresenceAccess } from "./presence";
import { computeTeamMembers } from "./teams";
import { revokeToken } from "./tokens";
import { isAllowedEmail, isEmailShapeValid } from "../generated/policy";

type Db = admin.firestore.Firestore;
type Ref = admin.firestore.DocumentReference;

// --- Google's word for the address ------------------------------------------

const GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** An unknown key id is fetched again at most this often, so it cannot be a lever. */
const KEY_REFETCH_GAP_MS = 60_000;

let googleKeys: { byKid: Map<string, KeyObject>; until: number; fetchedAt: number } | null = null;

async function googleKey(kid: string): Promise<KeyObject | null> {
  const now = Date.now();
  if (googleKeys && googleKeys.byKid.has(kid) && googleKeys.until > now) {
    return googleKeys.byKid.get(kid) ?? null;
  }
  // Google rotates its keys, so an id we have not seen means fetch again —
  // but not on every request that names one.
  if (googleKeys && googleKeys.until > now && now - googleKeys.fetchedAt < KEY_REFETCH_GAP_MS) {
    return null;
  }
  const res = await fetch(GOOGLE_KEYS_URL);
  if (!res.ok) throw new Error(`Google signing keys: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const byKid = new Map<string, KeyObject>();
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    if (jwk && typeof jwk.kid === "string" && jwk.kty === "RSA") {
      byKid.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
  }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  googleKeys = { byKid, until: now + (maxAge ? Number(maxAge[1]) * 1000 : 0), fetchedAt: now };
  return byKid.get(kid) ?? null;
}

function jsonPart(segment: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The claims of a Google ID token whose signature checks out, or null.
 *
 * Verified here with Google's published keys rather than its tokeninfo
 * endpoint, which Google throttles and says is not for production. `aud` is
 * deliberately not checked: the caller binds the token by `sub` to an account
 * that already signed in with that Google account, so the most any token can
 * do is say what Google vouches for that account now (ADR 0020).
 */
async function signedGoogleClaims(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = await googleKey(header.kid);
  if (!key) return null;
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], "base64url"),
  );
  if (!signed) return null;
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) return null;
  if (!(Number(claims.exp) * 1000 > Date.now())) return null;
  return claims;
}

/**
 * The Auth emulator's Google token, which nobody signs: strict JSON, or a JWT
 * with no signature. Trusted only while `FIREBASE_AUTH_EMULATOR_HOST` is set,
 * the same switch under which firebase-admin itself accepts unsigned tokens.
 */
function emulatorGoogleClaims(token: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(token);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* not JSON: try it as an unsigned JWT */
  }
  const parts = token.split(".");
  return parts.length >= 2 ? jsonPart(parts[1]) : null;
}

/**
 * The address Google vouches for this account under, or null.
 *
 * `linkedSubs` comes from the caller's VERIFIED Firebase token, so a Google
 * token for somebody else's Google account is refused. `email_verified` is
 * compared as a string because Google writes it either way, and `"false"` is
 * truthy.
 */
export async function googleAddress(
  googleIdToken: unknown,
  linkedSubs: readonly string[],
): Promise<string | null> {
  if (typeof googleIdToken !== "string" || googleIdToken.length === 0 || googleIdToken.length > 8192) {
    return null;
  }
  let claims: Record<string, unknown> | null;
  try {
    claims = process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? emulatorGoogleClaims(googleIdToken)
      : await signedGoogleClaims(googleIdToken);
  } catch (err) {
    console.error("could not check a Google token:", (err as Error)?.message ?? err);
    return null;
  }
  if (!claims) return null;
  if (String(claims.email_verified) !== "true") return null;
  if (typeof claims.sub !== "string" || !linkedSubs.includes(claims.sub)) return null;
  if (typeof claims.email !== "string") return null;
  const email = normalizeEmail(claims.email);
  if (!isEmailShapeValid(email) || !isAllowedEmail(email)) return null;
  return email;
}

// --- The job ------------------------------------------------------------------

export type MoveState = "pending" | "done" | "blocked";

export interface MoveJob {
  uid: string;
  from: string;
  to: string;
  state: MoveState;
  reason?: "address-taken" | "stale";
}

/** One job per account and destination, so a second tab finds the first one's. */
export function moveJobId(uid: string, to: string): string {
  return `${uid}~${createHash("sha256").update(to).digest("hex").slice(0, 16)}`;
}

/**
 * Ask for a move. A move already pending is the same move, which is the lease
 * that keeps two tabs from running two; a finished or blocked one is asked
 * again, because the person would not be asking if it had worked.
 */
export async function requestMove(db: Db, uid: string, from: string, to: string): Promise<string> {
  const ref = db.collection("accountMoves").doc(moveJobId(uid, to));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.state === "pending") return;
    tx.set(ref, { uid, from, to, state: "pending", requestedAt: FieldValue.serverTimestamp() });
  });
  return ref.id;
}

// --- Rewriting what names the old address -------------------------------------

type Phase = "add" | "replace";

const rank = (role: Role) => ROLES.indexOf(role);

function roleIn(grants: RoleGrants, principal: string): Role | null {
  for (const role of [...ROLES].reverse()) {
    if (grants[GRANT_LIST[role]].includes(principal)) return role;
  }
  return null;
}

/**
 * A node's grants with `to` holding what `from` held, or the higher role if it
 * already held one of its own. `add` keeps `from` beside it; `replace` drops
 * it. On a node `from` owns, `add` grants `to` the top role until `replace`
 * makes it the owner, and an owner is never also a grant (`applyAccessDelta`).
 */
export function movedGrants(
  grants: RoleGrants,
  ownerBefore: string,
  from: string,
  to: string,
  phase: Phase,
): RoleGrants {
  const ownerAfter = phase === "replace" && ownerBefore === from ? to : ownerBefore;
  const fromRole = roleIn(grants, from);
  const toRole = roleIn(grants, to);
  let target: Role | null =
    fromRole && toRole ? (rank(fromRole) >= rank(toRole) ? fromRole : toRole) : (fromRole ?? toRole);
  if (phase === "add" && ownerBefore === from) target = "approver";
  const out = {} as RoleGrants;
  for (const role of ROLES) {
    out[GRANT_LIST[role]] = grants[GRANT_LIST[role]].filter(
      (p) => p !== to && !(phase === "replace" && p === from),
    );
  }
  if (target && to !== ownerAfter) {
    out[GRANT_LIST[target]] = [...out[GRANT_LIST[target]], to].sort();
  }
  return out;
}

/** Who the change log says moved an address: the account that moved. */
export interface MoveAudit {
  entryId: string;
  actor: Actor;
}

/**
 * Rewrite one document's or folder's own fields; true when it named `from`
 * itself.
 *
 * On `replace`, the same transaction tells the record's owner, in the log
 * that exists to say who changed access, that the address moved: an `acl`
 * entry, and on a document an `access.changed` event. Only here, where the
 * address was named directly, since a record that merely inherited it did not
 * change; and in the same transaction, so a job that dies after a rewrite has
 * already said so. Both have fixed ids, so a redelivery writes neither twice.
 */
async function rewriteNode(
  db: Db,
  ref: Ref,
  from: string,
  to: string,
  phase: Phase,
  audit: MoveAudit,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() ?? {};
    const owner = normalizeEmail(String(data.ownerEmail ?? ""));
    const grants = grantsOf(data);
    if (owner !== from && roleIn(grants, from) === null) return false;
    const isDoc = ref.parent.id === "docs";
    const entryRef = ref.collection("acl").doc(audit.entryId);
    const eventRef = ref.collection("events").doc(audit.entryId);
    const [entry, event] =
      phase === "replace"
        ? await Promise.all([tx.get(entryRef), isDoc ? tx.get(eventRef) : Promise.resolve(null)])
        : [null, null];

    const next = movedGrants(grants, owner, from, to, phase);
    const patch: Record<string, unknown> = { ...next };
    if (phase === "replace" && owner === from) patch.ownerEmail = to;
    tx.set(ref, patch, { merge: true });

    if (entry && !entry.exists) {
      tx.set(entryRef, {
        at: FieldValue.serverTimestamp(),
        actor: audit.actor,
        reason: "address-moved",
        added: [to],
        removed: [from],
        ...next,
      });
    }
    if (event && !event.exists) {
      tx.set(
        eventRef,
        eventRecord({
          type: "access.changed",
          audience: "editors",
          actor: eventActor(audit.actor),
          // Said as what it is, so the feed shows an address changing, not
          // the new address granting itself access (SPEC §17).
          data: { added: [to], removed: [from], reason: "address-moved" },
        }),
      );
    }
    return true;
  });
}

/** Rewrite one team's owner, admins and members; true when it named `from`. */
async function rewriteTeam(db: Db, ref: Ref, from: string, to: string, phase: Phase): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => normalizeEmail(String(x))) : []);
    const owner = normalizeEmail(String(data.ownerEmail ?? ""));
    const members = list(data.members);
    const admins = list(data.admins);
    if (owner !== from && !members.includes(from) && !admins.includes(from)) return false;
    const swap = (xs: string[]) => {
      const set = new Set(xs);
      if (set.has(from)) set.add(to);
      if (phase === "replace") set.delete(from);
      return [...set].sort();
    };
    const ownerAfter = phase === "replace" && owner === from ? to : owner;
    tx.set(
      ref,
      {
        ownerEmail: ownerAfter,
        admins: swap(owner === from ? [...admins, from] : admins),
        members: computeTeamMembers(ownerAfter, swap(owner === from ? [...members, from] : members)),
      },
      { merge: true },
    );
    return true;
  });
}

/** Everything that still lets `from` in: `members` holds the owner and every grantee. */
async function stillNaming(db: Db, from: string) {
  const ids = async (collection: string, field: string) =>
    (await db.collection(collection).where(field, "array-contains", from).get()).docs.map((d) => d.id);
  const [docs, folders, teams, teamAdmins] = await Promise.all([
    ids("docs", "members"),
    ids("folders", "members"),
    ids("teams", "members"),
    ids("teams", "admins"),
  ]);
  return { docs, folders, teams: [...new Set([...teams, ...teamAdmins])] };
}

const QUIET = { touchUpdatedAt: false } as const;

/**
 * One pass over everything that names `from`: rewrite each record's own fields,
 * then recompute every record found, named or not. A record found only through
 * a folder or a team is fixed by recomputing it; recomputing them all is what
 * lets a redelivery finish a pass that died between a rewrite and its cascade.
 */
async function pass(db: Db, from: string, to: string, phase: Phase, audit: MoveAudit) {
  const found = await stillNaming(db, from);
  const named = { docs: [] as string[], folders: [] as string[], teams: [] as string[] };
  for (const id of found.teams) {
    if (await rewriteTeam(db, db.collection("teams").doc(id), from, to, phase)) named.teams.push(id);
  }
  for (const id of found.folders) {
    if (await rewriteNode(db, db.collection("folders").doc(id), from, to, phase, audit)) named.folders.push(id);
  }
  for (const id of found.docs) {
    if (await rewriteNode(db, db.collection("docs").doc(id), from, to, phase, audit)) named.docs.push(id);
  }

  for (const id of found.teams) await refanTeam(db, id, QUIET);

  // Parents before children, sorted here rather than by the query: ordering
  // by `depth` would need a composite index the emulator never asks for.
  const folders = (await Promise.all(found.folders.map((id) => db.collection("folders").doc(id).get())))
    .filter((s) => s.exists)
    .sort((a, b) => Number(a.data()?.depth ?? 0) - Number(b.data()?.depth ?? 0));
  const done = new Set<string>();
  for (const snap of folders) {
    const ancestors: unknown[] = Array.isArray(snap.data()?.ancestors) ? snap.data()!.ancestors : [];
    if (ancestors.some((a) => typeof a === "string" && done.has(a))) {
      done.add(snap.id);
      continue;
    }
    await recomputeSubtree(db, snap.id, QUIET);
    done.add(snap.id);
  }

  for (const id of found.docs) {
    const ref = db.collection("docs").doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    await persistDocMembership(db, ref, undefined, undefined, QUIET);
  }
  return { found, named };
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "auth/user-not-found";
}

/**
 * Run one move to completion, or throw so the trigger retries it.
 *
 * Idempotent from any point: the Auth record says whether the commit has
 * happened, and every other step is found again by query.
 */
export async function runMove(db: Db, jobId: string, job: MoveJob): Promise<MoveState> {
  const auth = admin.auth();
  const jobRef = db.collection("accountMoves").doc(jobId);
  const finish = async (state: MoveState, reason?: MoveJob["reason"]) => {
    await jobRef.set(
      { state, ...(reason ? { reason } : {}), finishedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return state;
  };

  const audit: MoveAudit = {
    entryId: `moved-${jobId}`,
    actor: { uid: job.uid, email: job.to, channel: "web" },
  };

  const user = await auth.getUser(job.uid);
  const current = normalizeEmail(user.email ?? "");
  if (current !== job.from && current !== job.to) return finish("blocked", "stale");
  const committed = current === job.to;

  if (!committed) {
    // One account per address. An account that holds it without ever having
    // proved it can never pass the gate, so it owns nothing: Firebase itself
    // drops such an account when a provider it trusts vouches for the address.
    // One that did prove it is a second person, or the same one twice, and
    // merging them is not something to do silently.
    let holder: admin.auth.UserRecord | null = null;
    try {
      holder = await auth.getUserByEmail(job.to);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (holder && holder.uid !== job.uid) {
      const passwordOnly = holder.providerData.every((p) => p.providerId === "password");
      if (holder.emailVerified || !passwordOnly) return finish("blocked", "address-taken");
      await auth.deleteUser(holder.uid);
      await db.collection("users").doc(holder.uid).delete();
      await db.collection("verifications").doc(holder.uid).delete();
    }
    // A code requested before the move would otherwise put the old address
    // back. `verification` on the record is where one was kept before 0.29.1.
    await db.collection("verifications").doc(job.uid).delete();
    await db.collection("users").doc(job.uid).set({ verification: FieldValue.delete() }, { merge: true });

    await pass(db, job.from, job.to, "add", audit);

    // The commit. Firebase revokes on an email change in production; saying so
    // explicitly makes the emulator do the same, so it is tested as it runs.
    await auth.updateUser(job.uid, { email: job.to, emailVerified: true });
    await auth.revokeRefreshTokens(job.uid);
  }

  // A personal token acts as the address it was minted under and never asks
  // again, so one still carrying the old address is revoked, not rewritten:
  // if that address is ever reassigned, the token would act as someone else.
  // Connected apps close on their own at their next refresh.
  const tokens = await db.collection("tokens").where("uid", "==", job.uid).get();
  let revoked = 0;
  for (const t of tokens.docs) {
    const d = t.data() ?? {};
    if (d.revokedAt == null && normalizeEmail(String(d.email ?? "")) === job.from) {
      if (await revokeToken(db, job.uid, t.id)) revoked += 1;
    }
  }

  const touched = new Set<string>();
  const named = { docs: new Set<string>(), folders: new Set<string>(), teams: new Set<string>() };
  for (let round = 0; round < 3; round += 1) {
    const { found, named: n } = await pass(db, job.from, job.to, "replace", audit);
    for (const id of found.docs) touched.add(id);
    for (const id of n.docs) named.docs.add(id);
    for (const id of n.folders) named.folders.add(id);
    for (const id of n.teams) named.teams.add(id);
    const left = await stillNaming(db, job.from);
    if (left.docs.length + left.folders.length + left.teams.length === 0) {
      await db.collection("users").doc(job.uid).set({ uid: job.uid, email: job.to }, { merge: true });
      // `syncPresenceAccess` swallows its own failures, so a mirror that still
      // keys the old address would be invisible. Once more, for every document
      // this run touched.
      for (const id of touched) {
        const d = (await db.collection("docs").doc(id).get()).data();
        if (!d) continue;
        const m = membershipOf(d);
        await syncPresenceAccess(id, m.members, m.editorMembers, opensEditingToAnyAccount(d as DocAclData));
      }
      console.log(
        JSON.stringify({
          severity: "INFO",
          event: "account_moved",
          docs: named.docs.size,
          folders: named.folders.size,
          teams: named.teams.size,
          tokensRevoked: revoked,
        }),
      );
      return finish("done");
    }
  }
  throw new Error("the old address is still named after three passes; retrying");
}
