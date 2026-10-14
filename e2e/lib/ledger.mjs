// SPDX-License-Identifier: Apache-2.0
// The run ledger: every account, document, token and grant a run creates, appended once (SPEC §12).

/**
 * One JSONL file per run, `<runDir>/ledger.jsonl`. Nothing is ever deleted from
 * a production deployment, so the ledger is how a run knows what it owns:
 * quarantine walks it, and the production guard refuses to act on a document
 * that is not in it.
 *
 * Rows are small (well under PIPE_BUF), so concurrent appends from parallel
 * spec processes each land whole. A row never carries a secret: tokens are
 * recorded by id, accounts without their password.
 *
 *   {t, runId, kind: "account", role, email, uid, tier}
 *   {t, runId, kind: "doc", docId, ownerEmail, via}
 *   {t, runId, kind: "folder", folderId, ownerEmail, actor, parentId, name}
 *   {t, runId, kind: "token", tokenId, uid, channel, name}
 *   {t, runId, kind: "grant", docId, email, role, via}
 *   {t, runId, kind: "grant", folderId, email, role, via: "folder-access"}
 *   {t, runId, kind: "oauth", tokenId, uid, clientId}
 *   {t, runId, kind: "absent", docId}
 *   {t, runId, kind: "team", teamId, ownerEmail, actor, name}
 *
 * An "absent" row is an id the run minted for an absent-id parity probe and
 * never created (seed.absentDocId). It is not a document: ledgerDocIds leaves
 * it out, so quarantine, which walks documents, never touches it, and the
 * production guard lets a write name it only after proving docs/<id> still
 * holds nothing (guard.absentDoc). An id the run did go on to create is a
 * document, and no longer absent.
 *
 * A "team" row is a team the run made with POST /team {op: "create"}
 * (seed.createTeam, SPEC §18). Teams are not documents or folders: nothing
 * here walks them, and the production guard refuses POST /team and
 * /team-members whatever the ledger says. The row is the record that the run
 * made the team, so whatever later cleans up or guards teams can know it.
 *
 * A "folder" row is a folder the run made (seed.createFolder, POST /folder);
 * the guard lets a write name it (rule "ledger-folder"). A "grant" row with a
 * folderId instead of a docId is a folder grant (grant.shareFolder), whose
 * `email` is the principal: an email, or `team:<teamId>`.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPath, ensureDir } from "./paths.mjs";

const SECRET_VALUE_RE = /\b(bsk|bsa|bsr)_[0-9a-f]{32}\.|eyJ[A-Za-z0-9_-]{10,}\.|\bre_e2e_[0-9a-f]+/;
const FORBIDDEN_KEYS = new Set(["password", "token", "idToken", "refreshToken", "secret", "plaintext", "sessionCookie"]);

export const LEDGER_KINDS = Object.freeze(["account", "doc", "folder", "token", "grant", "oauth", "absent", "team"]);

export function ledgerFile(target) {
  return assertPath(join(target.runDir, "ledger.jsonl"), "ledger");
}

/** Append one row. Refuses anything that looks like a credential. */
export function appendLedger(target, row) {
  if (!LEDGER_KINDS.includes(row?.kind)) throw new Error(`ledger: unknown kind ${JSON.stringify(row?.kind)}`);
  for (const k of Object.keys(row)) {
    if (FORBIDDEN_KEYS.has(k)) throw new Error(`ledger: a row never carries ${k}`);
  }
  const line = JSON.stringify({ t: new Date().toISOString(), runId: target.runId, ...row });
  if (SECRET_VALUE_RE.test(line)) throw new Error("ledger: refusing a row that holds a credential-shaped value");
  ensureDir(target.runDir, "runDir");
  appendFileSync(ledgerFile(target), line + "\n");
  return row;
}

/** Every row, oldest first. A torn last line (a writer mid-append) is skipped. */
export function readLedger(target) {
  const file = ledgerFile(target);
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {}
  }
  return rows;
}

/** The ids of every document this run created. */
export function ledgerDocIds(target) {
  return new Set(readLedger(target).filter((r) => r.kind === "doc").map((r) => r.docId));
}

/** The ids this run minted as absent-id probes and never created (kind "absent", minus any "doc"). */
export function ledgerAbsentIds(target, rows = readLedger(target)) {
  const docs = new Set(rows.filter((r) => r.kind === "doc").map((r) => r.docId));
  return new Set(rows.filter((r) => r.kind === "absent" && !docs.has(r.docId)).map((r) => r.docId));
}

/** Every run account by lowercased email. */
export function ledgerAccounts(target) {
  const out = new Map();
  for (const r of readLedger(target)) if (r.kind === "account") out.set(String(r.email).toLowerCase(), r);
  return out;
}
