// SPDX-License-Identifier: Apache-2.0
// Every deployed function, re-exported from the endpoints module that holds it (SPEC §2).

/**
 * Region is FIXED at us-central1: Hosting rewrites only reach functions there.
 *
 * Every endpoint is AUTH-FIRST. Authentication is resolved before anything that
 * could reveal whether a document exists, and the read-only byte paths collapse
 * "you may not read this" into 404 so a signed-in stranger cannot enumerate the
 * slug space (SPEC §1.4b).
 *
 * Clients never write docs/*, versions/*, folders/*, teams/* or public/*.
 * firestore.rules denies all of it; these functions use the Admin SDK, which
 * bypasses rules, and are therefore the only sanctioned write path.
 *
 * Each module under endpoints/ is one or more of this file's former sections,
 * moved as they were. endpoints/runtime.ts calls setGlobalOptions and holds the
 * option sets, and every module takes its option set from there, so the
 * global options are in force before any function is defined: onRequest reads
 * them at the call, not at deploy (functions/test/wiring.test.js pins it).
 */

import "./lib/mcp-transport";

export { health, session, appConfig } from "./endpoints/session";
export { contentProxy, saveThumbs, downloadBundle } from "./endpoints/content";
export { setAccess, setVisibility, trustDoc, setMarking } from "./endpoints/sharing";
export { saveDraft, getDraft, commitVersion } from "./endpoints/editing";
export {
  manageSuggestion,
  createDoc,
  createFolder,
  setFolderAccess,
  organize,
  forkDoc,
} from "./endpoints/workspace";
export { recordView, unlockDoc } from "./endpoints/reading";
export { verifyEmail } from "./endpoints/verification";
export { purgeTrash, manageTokens, manageTeam, manageTeamMembers } from "./endpoints/account";
export { sitemap, docShell, docMarkdown } from "./endpoints/discovery";
export {
  onCommentCreated,
  moveAccount,
  purgeExpiredTrash,
  applyExpiries,
  recordVersionEvent,
  recordThreadEvent,
  recordCommentEvent,
} from "./endpoints/triggers";
export { mcp, oauth, oauthConsent } from "./endpoints/agents";
