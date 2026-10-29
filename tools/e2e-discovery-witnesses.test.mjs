// SPDX-License-Identifier: Apache-2.0
// Preserve each discovered defect's exact affected case and N-axis obligations without freezing its eventual disposition (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const campaign = JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url), "utf8"));
const expected = [
  {
    "id": "coverage-new-version-dialog",
    "claim": "Cover Upload a new version dialog: success, each refusal and message, with negative controls. Added after the original critics.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.7 Upload a new version from the workspace preserves the address, explains refusals, retries, reports identical files and blocks an outdated open dialog"
      },
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.7b workspace revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors"
      },
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.8b dropped revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors"
      }
    ]
  },
  {
    "id": "coverage-new-version-drop",
    "claim": "Cover dropping a file onto an open document: success, each refusal and message, with negative controls. Added after the original critics.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.8 dropping a file onto an open document offers a confirmed revision, cancel sends nothing, and a refused file can be replaced before publishing"
      },
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.8b dropped revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors"
      },
      {
        "caseId": "e2e/specs/functional/a14-workspace.spec.mjs::A14.7b workspace revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors"
      }
    ]
  },
  {
    "id": "email-provider-hang",
    "claim": "A provider that never sends headers or leaves its JSON body incomplete can indefinitely delay a request after its access grant is persisted. Bound each provider send to ten seconds and cancel it without losing the grant or subsequent invitations.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a23-email.spec.mjs::A23.6c an unanswered provider request is cancelled and the grant answers 200 while the provider is still held"
      },
      {
        "caseId": "e2e/specs/functional/a23-email.spec.mjs::A23.6d an incomplete provider response body shares the send deadline and cannot hold the grant response"
      }
    ]
  },
  {
    "id": "presence-first-session-cleanup",
    "claim": "Session-owned presence rules rejected onDisconnect removal on a new absent path, preventing reader announcements until a later mode or viewport write. The delete gate now admits an absent no-op while rechecking ownership when cleanup fires.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a11-live.spec.mjs::A11.2 a peer's presence chip shows data-mode=edit while they edit, in one colour that survives a mode change, a reload and the caret overlay"
      },
      {
        "caseId": "e2e/specs/functional/a11-live.spec.mjs::A11.10 closing an editor's tab removes their peer node and their chip within 5 s"
      }
    ]
  },
  {
    "id": "toolbar-inline-code-and-link",
    "claim": "Previously unexercised Inline code and Link controls did nothing in the real sandboxed editor. Native inline insertion now retains undo, rich selection, surrounding text and authored styles; link prompts originate in the app window.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a09-editing.spec.mjs::A9.3b Inline code changes the selected content and survives autosave"
      },
      {
        "caseId": "e2e/specs/functional/a09-editing.spec.mjs::A9.3b Link changes the selected content and survives autosave"
      }
    ]
  },
  {
    "id": "live-done-queued-delta-loss",
    "claim": "Done could tear down the shared connection after its HTTP draft saved but before queued Yjs updates were acknowledged, discarding buffered typing that a remaining editor never received. Preserve the queue, bound delivery, retain the editor on failure, and drain before teardown.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 delivery timeout keeps saved local typing open until the live queue recovers",
        "n": 2
      }
    ]
  },
  {
    "id": "live-forced-close-partial-history-adoption",
    "claim": "A forced close can leave a durable saved causal frontier ahead of the acknowledged live log. A later join could adopt partial history over the complete saved HTML. Warn on pending delivery; validate the session frontier; block incomplete adoption and offer explicit Leave editing/agent recovery.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 abrupt close preserves an ahead saved draft, blocks partial live adoption and permits explicit agent recovery",
        "n": 2
      }
    ]
  },
  {
    "id": "live-done-unbounded-wait",
    "claim": "Done could wait without a total deadline when durable saving remained in flight or remote input repeatedly extended saving. Bound the whole operation, retain a retryable editor without aborting a potentially committed request, and allow a later retry.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 Done deadline preserves the editor while a durable save is held and permits retry after its answer",
        "n": 2
      }
    ]
  },
  {
    "id": "operator-realtime-client-lifecycle",
    "claim": "Once operator RTDB initialization was corrected, completed commands retained an open Admin SDK connection and hung until killed. Close the owned app only after work settles, preserving dry-run laziness and error reporting.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/smoke/clients.spec.mjs::clients: the operator script publishes a sample into this stack"
      }
    ]
  },
  {
    "id": "empty-shared-history-rejected",
    "claim": "An untouched empty document legitimately has an empty Yjs insertion vector; the new causal parser rejected this valid history, preventing normal shared saves. Permit zero entries while retaining malformed-clock/range validation.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a11-live.spec.mjs::A11.14 an untouched empty shared body can save its empty causal history before publication"
      }
    ]
  },
  {
    "id": "review-entry-resets-active-editor",
    "claim": "Starting a review pass inside an active editor re-entered asynchronous draft preparation, cleared the pass and remounted unsaved content. Ordinary entry now preserves the active editing snapshot; Reload and Take theirs remain explicit.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a08-review.spec.mjs::A8.2 the pass marks the quote with the CSS highlight API and zero mutations of the frame's document; Accept sends claim, then POST /draft, then accept, each after the last answered; the change lands once"
      },
      {
        "caseId": "e2e/specs/functional/a09-editing.spec.mjs::A9.1 entering edit mode on a trusted document mounts a new iframe with sandbox=allow-same-origin, src /draft/…?r=N, an editable body and the Formatting toolbar"
      }
    ]
  },
  {
    "id": "mcp-update-loses-presented-link-proof",
    "claim": "MCP update_document initially authorized an unlisted open-editing link but dropped its presented key before final transactional authority validation, refusing a legitimate update. Carry only the request proof through the final check and still reject a rotated key or revoked real editor.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a20-mcp.spec.mjs::A20.6 a link key opens an unlisted open-editing document to a non-member on each of the nine tools SPEC §19 names; without it, or with a wrong one, each answers exactly as for an id that does not exist"
      }
    ]
  },
  {
    "id": "print-comments-pane-hides-document",
    "claim": "Native printing activated the phone comments-pane rule and hid the document, yielding an incomplete print and restoring scroll into a hidden frame. Restrict pane switching to screen media and test the complete compiled app stylesheet in real Chrome.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a17-export.spec.mjs::A17.6 File → Print (the browser's own print): the frame opens to its content's full height and the PDF paginates, then it closes with the reader's scroll position back; no stamp and no print frame; the viewer's chrome is hidden on paper"
      }
    ]
  },
  {
    "id": "print-chrome-cascade-leak",
    "claim": "Later feature display rules could override print hiding and include application chrome in printed output. The full app stylesheet now preserves print hiding across its cascade, with independent rendered-chrome assertions.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a17-export.spec.mjs::A17.6 File → Print (the browser's own print): the frame opens to its content's full height and the PDF paginates, then it closes with the reader's scroll position back; no stamp and no print frame; the viewer's chrome is hidden on paper"
      }
    ]
  },
  {
    "id": "changes-partial-cursor-restarts-feed",
    "claim": "A cursor with a partial position, such as event fields without the sequence field, could silently restart the feed. This is separate from the original empty event-id cursor and must retain its own malformed-position witness.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a21-changes.spec.mjs::A21.5 a cursor from another document, a malformed one, one of an unknown version, \"now\", \"start\" and a missing since are each a tool error, never read as start or now, and move no saved cursor"
      }
    ]
  },
  {
    "id": "refused-upload-leaves-unreachable-bundle",
    "claim": "Immutable version candidates uploaded before a known transaction refusal remained unreachable in Storage. Delete only candidates known not to have committed; retain bytes after uncertain outcomes.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c08-mint-races.spec.mjs::C8 divergent draft snapshots (SYNC-P): the first commit reads D1, later editors save newer snapshots, and every commit uploads before transactions run; D1 is refused with draftChanged and exactly one current snapshot is published with its own bytes (I7)",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c08-mint-races.spec.mjs::C9 S4 (SYNC-P): N agents' updates on v1 held before they choose a version id, the first let go to upload and held before its transaction, the rest let go to choose the same id and upload over it; the version's stored bytes are the winner's (I7)",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version",
        "n": 5
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version",
        "n": 10
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version",
        "n": 20
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens",
        "n": 5
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens",
        "n": 10
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens",
        "n": 20
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12e CAS candidate reuse: a held older causal save loses its exact precondition to a newer save, acknowledges the newer draft, and deletes only its unreferenced upload",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12e CAS candidate refusal: a held draft loses its exact precondition to publication, refuses the old base, and deletes only its unreferenced upload",
        "n": 2
      }
    ]
  },
  {
    "id": "postcommit-projection-failure-reports-refusal",
    "claim": "A projection refresh failure after an external draft transaction had committed could turn the response into a refused write, misleading callers about persisted state. Treat postcommit projection maintenance separately from transactional success.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.8 a failed postcommit projection refresh still returns 200 for the durable draft and serves its exact bytes"
      }
    ]
  },
  {
    "id": "account-optout-restoration-race",
    "claim": "Saved analytics opt-out was restored only on the account page, allowing collection before preference resolution on normal entry; an SDK load already in flight also needed to recheck changed consent/opt-out. Resolve preferences at session entry, fail closed while pending, and recheck after asynchronous boundaries.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a19-account.spec.mjs::A19.2 account analytics opt-out survives reload and another browser, and the checkbox can enable and disable collection"
      },
      {
        "caseId": "e2e/specs/functional/a19-account.spec.mjs::A19.2 with analytics live, declining fetches nothing and is remembered, and \"unanswered → Allow\" in one page fetches the measurement script once, with page views off; every analytics request is fulfilled locally"
      }
    ]
  },
  {
    "id": "n20-common-document-transaction-timeouts",
    "claim": "At N20, common-document view/thumbnail/draft traffic produced ABORTED transaction lock timeouts and Functions worker/socket failures. The exact installed lock-upgrade cycle reproduces independently; attribution of each request and the required product response remain under investigation.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c01-typing.spec.mjs::C21 autosave rate: N editors type a token each in step and pause past the debounce, 6 times, so their autosaves land on one document together; no save state is ever \"error\" and every POST /draft is answered 200 (p95 under 3 s asserted on production only)",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c01-typing.spec.mjs::C1-serial positive control: the same typing one editor after another passes every C1 oracle but S3's and C21's (every save 200, never an error), and editing one editor at a time shows nobody the conflict banner",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c01-typing.spec.mjs::C1-serial positive control: the same typing one editor after another passes every C1 oracle but S3's and C21's (every save 200, never an error), and editing one editor at a time shows nobody the conflict banner",
        "n": 20
      },
      {
        "caseId": "e2e/specs/concurrency/c01-typing.spec.mjs::C21 autosave rate: N editors type a token each in step and pause past the debounce, 6 times, so their autosaves land on one document together; no save state is ever \"error\" and every POST /draft is answered 200 (p95 under 3 s asserted on production only)",
        "n": 20
      },
      {
        "caseId": "e2e/specs/concurrency/c01-typing.spec.mjs::C21 draft: after N editors' autosaves raced onto one document (two in flight at once, proven), GET /draft's body equals every peer's and holds every token once and whole (I5 apart from S3's spellcheck, I2 in the draft)",
        "n": 20
      }
    ]
  },
  {
    "id": "stale-done-completes-in-replacement-editor",
    "claim": "An old Done deadline can set error state in a replacement editing session, and an unmounted viewer can show its old global failure toast after navigation. Bind pending completion to its originating session and viewer lifetime.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 a timed-out Done from a replaced frame cannot change its new editing session",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 a timed-out Done from another document cannot change the replacement editor or report its failure there",
        "n": 2
      }
    ]
  },
  {
    "id": "rtdb-rule-coverage-retains-live-payloads",
    "claim": "The pinned RTDB emulator retains every distinct evaluated rule value, including large live payloads, until its rule tracker is replaced. Accumulated diagnostics exhausted its heap during N20. Archive and recycle coverage only at verified quiescent exclusive boundaries while restoring exact rules.",
    "requiredCases": []
  },
  {
    "id": "early-e2e-report-accepted-as-completed-run",
    "claim": "An early merged all-pass report could qualify as a complete matrix cell despite an interrupted invocation or missing later cases. Whole-run proofs now require successful completion metadata and exact final reporter records.",
    "requiredCases": []
  },
  {
    "id": "thumbnail-revocation-during-upload",
    "claim": "An editor downgraded or removed while JPEG upload was in flight could still set a shared thumbnail pointer. Recheck current editor authority inside the metadata transaction, preserve reader-aware403/404, and retire only the rejected upload key.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/concurrency/c17-identity.spec.mjs::C17c thumbnail authority: an editor downgraded after JPEG upload receives 403, changes no thumbnail, and deletes only its candidate (SPEC §2)",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c17-identity.spec.mjs::C17c thumbnail authority: an editor removed after JPEG upload receives 404, changes no thumbnail, and deletes only its candidate (SPEC §2)",
        "n": 2
      },
      {
        "caseId": "e2e/specs/concurrency/c17-identity.spec.mjs::C17c thumbnail authority: the owner still stores and serves its exact JPEGs after removing another editor during upload (SPEC §2)",
        "n": 2
      }
    ]
  },
  {
    "id": "native-transaction-ack-loss-misclassifies-own-commit",
    "claim": "A native transaction can durably commit, lose its acknowledgement, and retry the callback. Draft saves, draft/external publication, thumbnail writes and operator publish/withdraw treated their own committed pointer as a conflict, duplicate or losing upload; some cleanup then deleted bytes still referenced by immutable versions or draft metadata. Recognize the unique completed operation before fresh-write guards and finish its captured retirement; delete a known refused candidate only after proving no draft or version references it. The same native commit-acknowledgement boundary also caused false feedback refusals, duplicate revision/read/verification effects, suppressed notices or invitations, unsafe OAuth replay handling, and replayed membership, rename, or suggestion lease changes. Later legitimate operations could erase mutable receipt evidence or have their results overwritten; deletable ordinary feedback could be recreated. Each case must prove its own real durable commit and installed SDK retry before judging the exact operation-specific result.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9c external publication survives native commit acknowledgement loss without deleting the committed version"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9e thumbnail cover and slides survive native commit acknowledgement loss and serve the exact recorded JPEGs"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9b draft publication survives native commit acknowledgement loss without deleting the committed version"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9d deduplicated draft publication survives native commit acknowledgement loss and completes retirement"
      },
      {
        "caseId": "e2e/specs/functional/a12-operator-ack.spec.mjs::A12.10a an operator publish completes its exact retirement after native commit acknowledgement loss without reporting its own commit as a duplicate"
      },
      {
        "caseId": "e2e/specs/functional/a12-operator-ack.spec.mjs::A12.10b an operator withdrawal completes its exact retirement and removes only the withdrawn version after native commit acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9a a remembered-link draft survives native commit acknowledgement loss and serves its exact committed bytes"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9f deduplicated publication acknowledges its retirement after a later publication and draft save"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9h a remembered-link save acknowledges its commit after a later editor saves another draft"
      },
      {
        "caseId": "e2e/specs/functional/a12-versions.spec.mjs::A12.9g a thumbnail acknowledges its committed upload and finishes obsolete cleanup after a later publication and thumbnail replace it"
      },
      {
        "caseId": "e2e/specs/functional/a12-operator-ack.spec.mjs::A12.10c an operator access grant ACK retry preserves a later real revocation and its mirrors"
      },
      {
        "caseId": "e2e/specs/functional/a12-operator-ack.spec.mjs::A12.10d an operator withdrawal ACK retry finishes captured cleanup while preserving a later publication"
      },
      {
        "caseId": "e2e/specs/functional/a07-thread-ack.spec.mjs::A7.8 a thread resolution acknowledges its committed note after native ACK loss without undoing a later reopen"
      },
      {
        "caseId": "e2e/specs/functional/a08-suggestion-ack.spec.mjs::A8.10a suggestion creation acknowledges its single committed annotation after native transaction acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a08-suggestion-ack.spec.mjs::A8.10b suggestion revision records exactly one history entry after native transaction acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a08-suggestion-lease-ack.spec.mjs::A8.11a a completed suggestion claim does not resurrect a lease released before its native retry"
      },
      {
        "caseId": "e2e/specs/functional/a08-suggestion-lease-ack.spec.mjs::A8.11b a completed suggestion release does not erase a newer same-account lease before its native retry"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11a a verification reservation survives native acknowledgement loss and mails its current code exactly once"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11b a wrong verification request spends one guess through native acknowledgement loss including the final slot"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11c a retried wrong code cannot spend a replacement challenge's guess budget"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11d member and public reading beats consume their five-minute cap once after native acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11e an administrator acknowledges self-removal after native transaction acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a12-endpoint-ack.spec.mjs::A12.11f a committed team addition keeps its invitation delta through native acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a14-membership-ack.spec.mjs::A14.8a a folder grant ACK retry retains its invitation delta without regranting access revoked by a later request"
      },
      {
        "caseId": "e2e/specs/functional/a14-membership-ack.spec.mjs::A14.8b a document grant ACK retry retains its invitation and one event without regranting access revoked by a later request"
      },
      {
        "caseId": "e2e/specs/functional/a14-rename-ack.spec.mjs::A14.9 a rename acknowledges its own native commit without overwriting a later rename or duplicating its change event"
      },
      {
        "caseId": "e2e/specs/functional/a20-mcp-ack.spec.mjs::A20.7a MCP add_comment acknowledges one committed thread after native transaction acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a20-mcp-ack.spec.mjs::A20.7b overlapping MCP get_document calls count each committed read once after native transaction acknowledgement loss"
      },
      {
        "caseId": "e2e/specs/functional/a20-mcp-ack.spec.mjs::A20.7c MCP add_comment acknowledges its commit without resurrecting feedback an author deletes before the native retry"
      },
      {
        "caseId": "e2e/specs/functional/a20-oauth-ack.spec.mjs::A20.oauth-ack the CLI first code exchange survives native ACK loss with one usable token while an independent replay still revokes it"
      },
      {
        "caseId": "e2e/specs/functional/a20-oauth-ack.spec.mjs::A20.oauth-ack-dcr a native code retry cannot revoke a later refreshed grant while independent code replay still can"
      },
      {
        "caseId": "e2e/specs/functional/a23-cooldown-ack.spec.mjs::A23.8a a comment cooldown claim surviving native ACK loss still delivers its winning notice exactly once"
      },
      {
        "caseId": "e2e/specs/functional/a23-cooldown-ack.spec.mjs::A23.8b a suggestion cooldown claim surviving native ACK loss still delivers its winning notice exactly once"
      },
      {
        "caseId": "e2e/specs/functional/a23-cooldown-ack.spec.mjs::A23.8c a reader whose document expires while its committed cooldown ACK is held receives no comment bytes after retry"
      }
    ]
  },
  {
    "id": "cli-watch-missed-notifications-and-replacement",
    "claim": "CLI watch mode can announce readiness yet miss the next save, and an atomic editor save replaces the inode watched by native notifications. Metadata recovery must deliver each later save without duplicate publishes or non-JSON stdout.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a20-cli.spec.mjs::A20.7s publish --watch --json publishes once per burst of saves: the first save, then one update per burst (two new versions, then an identical burst deduped), one JSON result each"
      }
    ]
  },
  {
    "id": "mcp-real-runtime-parse-headers",
    "claim": "Real Hosting parser refusals for malformed MCP application/json bypass both the handler and configured Hosting headers. Install transport headers at Node HTTP request start before the runtime listener, then verify the actual preview refusal. Preserve the original failed cloud observation.",
    "requiredCases": [
      {
        "caseId": "e2e/specs/functional/a20-mcp.spec.mjs::A20.3.parse malformed application/json is rejected with HTTP 400, a diagnostic, protected transport headers and no document mutation"
      }
    ]
  }
];
const candidateProvenance = {
  "scopeExtension": {
    "claim": "Conditional draft saves also left their unique uploaded candidate unreachable after a known terminal CAS refusal or reuse of a newer causal snapshot. Apply the existing full current-draft and retained-version reference proof before removing only that request's unreferenced candidate; uncertain outcomes, failed reference reads and referenced bytes remain protected.",
    "sourceRevision": "ecff5ed9597481188585b32d5abc17893af94510",
    "mechanism": "writeDraft marks a code 5/9 conditional-write refusal as candidateMayHaveCommitted, but both terminal-refusal and reused-newer-snapshot branches skip the existing read-only reference proof unless a transaction candidate was staged.",
    "specification": [
      "SPEC §2: conditional draft histories and immutable selected snapshot; unknown transaction outcomes retain potentially referenced bytes.",
      "SPEC §4: a known terminal refusal permits cleanup only after a fresh transactional read of the current draft and every retained version proves the unique candidate unreferenced.",
      "SPEC §6a: successful agent replacement drops replaced draft files and live log.",
      "SPEC §9 permits unselected operator attempt bundles; this extension concerns completed web draft saves and does not remove the uncertain-outcome safety boundary."
    ],
    "observations": [
      {
        "artifact": "e2e/.out/2610150626-sgr7/invocations/20261015T132702Z-p54429-krtc/results-concurrency.jsonl",
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version [N=2]",
        "n": 2,
        "trial": 1,
        "status": "fail",
        "errorCode": "ERR_ASSERTION",
        "errorMessage": "C12a draft: the update drops the draft it replaced — 2 object(s) left under docs/{d}/draft/ (docs/e2e-26sgr7-live-yvnj/bundles/043cfa3e-e99f-4adf-9716-021ab2dd0235/index.html, docs/e2e-26sgr7-live-yvnj/bundles/c747d696-3427-4020-a7d5-ddbbbcee5e23/index.html)"
      },
      {
        "artifact": "e2e/.out/2610150626-sgr7/invocations/20261015T132702Z-p54429-krtc/results-concurrency.jsonl",
        "caseId": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs::C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens [N=2]",
        "n": 2,
        "trial": 1,
        "status": "fail",
        "errorCode": "ERR_ASSERTION",
        "errorMessage": "C12c draft: the update drops the draft it replaced — 1 object(s) left under docs/{d}/draft/ (docs/e2e-26sgr7-live-sq94/bundles/611b7111-afbe-49ff-82a6-314eed740114/index.html)"
      }
    ]
  },
  "sourceCommit": "2e4a75015b1782f70f71b744b51afda2a51d661c",
  "evidence": [
    "e2e/.out/draft-race-controls/candidate-cleanup-red.log",
    "e2e/.out/draft-race-controls/candidate-cleanup-green.log"
  ],
  "controls": [
    {
      "set": "controls-c08-candidate-cleanup",
      "target": {
        "spec": "e2e/specs/concurrency/c08-mint-races.spec.mjs",
        "case": "C8 divergent draft snapshots (SYNC-P): the first commit reads D1, later editors save newer snapshots, and every commit uploads before transactions run; D1 is refused with draftChanged and exactly one current snapshot is published with its own bytes (I7) [N=2]",
        "suite": "concurrency"
      },
      "intendedFailure": "^C8 cleanup:"
    },
    {
      "set": "controls-c09-candidate-cleanup",
      "target": {
        "spec": "e2e/specs/concurrency/c08-mint-races.spec.mjs",
        "case": "C9 S4 (SYNC-P): N agents' updates on v1 held before they choose a version id, the first let go to upload and held before its transaction, the rest let go to choose the same id and upload over it; the version's stored bytes are the winner's (I7) [N=2]",
        "suite": "concurrency"
      },
      "intendedFailure": "^C9 cleanup:"
    },
    {
      "set": "controls-c12-cas-reused-candidate",
      "target": {
        "spec": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs",
        "case": "C12e CAS candidate reuse: a held older causal save loses its exact precondition to a newer save, acknowledges the newer draft, and deletes only its unreferenced upload [N=2]",
        "suite": "concurrency"
      },
      "intendedFailure": "^C12e CAS reused candidate: the discarded upload remains unreferenced but present"
    },
    {
      "set": "controls-c12-cas-refusal-candidate",
      "target": {
        "spec": "e2e/specs/concurrency/c12-agent-vs-editors.spec.mjs",
        "case": "C12e CAS candidate refusal: a held draft loses its exact precondition to publication, refuses the old base, and deletes only its unreferenced upload [N=2]",
        "suite": "concurrency"
      },
      "intendedFailure": "^C12e CAS refused candidate: the discarded upload remains unreferenced but present"
    }
  ]
};
const nativeControls = [
  {
    "set": "controls-ack-external-refusal",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9c external publication survives native commit acknowledgement loss without deleting the committed version",
      "suite": "functional"
    },
    "intendedFailure": "ACK external-publish: its own durable commit is acknowledged with 200"
  },
  {
    "set": "controls-ack-thumb-loser",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9e thumbnail cover and slides survive native commit acknowledgement loss and serve the exact recorded JPEGs",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb cover: its own committed key reports stored true"
  },
  {
    "set": "controls-ack-draft-refusal",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9b draft publication survives native commit acknowledgement loss without deleting the committed version",
      "suite": "functional"
    },
    "intendedFailure": "ACK draft-publish: its own durable commit is acknowledged with 200"
  },
  {
    "set": "controls-ack-external-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9c external publication survives native commit acknowledgement loss without deleting the committed version",
      "suite": "functional"
    },
    "intendedFailure": "ACK external-publish: committed bytes remain readable"
  },
  {
    "set": "controls-ack-dedup-cleanup",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9d deduplicated draft publication survives native commit acknowledgement loss and completes retirement",
      "suite": "functional"
    },
    "intendedFailure": "ACK draft-dedup: success finishes retiring the old draft bytes"
  },
  {
    "set": "controls-ack-thumb-slides-loser",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9e thumbnail cover and slides survive native commit acknowledgement loss and serve the exact recorded JPEGs",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb slides: its own committed key reports stored true"
  },
  {
    "set": "controls-ack-thumb-slides-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9e thumbnail cover and slides survive native commit acknowledgement loss and serve the exact recorded JPEGs",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb slides: committed JPEG remains readable"
  },
  {
    "set": "controls-ack-draft-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9b draft publication survives native commit acknowledgement loss without deleting the committed version",
      "suite": "functional"
    },
    "intendedFailure": "ACK draft-publish: committed bytes remain readable"
  },
  {
    "set": "controls-operator-publish-ack",
    "target": {
      "spec": "e2e/specs/functional/a12-operator-ack.spec.mjs",
      "case": "A12.10a an operator publish completes its exact retirement after native commit acknowledgement loss without reporting its own commit as a duplicate",
      "suite": "functional"
    },
    "intendedFailure": "ACK operator publish: completed commit finishes its captured retirement"
  },
  {
    "set": "controls-operator-withdraw-ack",
    "target": {
      "spec": "e2e/specs/functional/a12-operator-ack.spec.mjs",
      "case": "A12.10b an operator withdrawal completes its exact retirement and removes only the withdrawn version after native commit acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK operator withdrawal: completed repoint finishes its captured retirement"
  },
  {
    "set": "controls-ack-dedup-refusal",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9d deduplicated draft publication survives native commit acknowledgement loss and completes retirement",
      "suite": "functional"
    },
    "intendedFailure": "ACK draft-dedup: its own durable commit is acknowledged with 200"
  },
  {
    "set": "controls-ack-thumb-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9e thumbnail cover and slides survive native commit acknowledgement loss and serve the exact recorded JPEGs",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb cover: committed JPEG remains readable"
  },
  {
    "set": "controls-ack-link-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9a a remembered-link draft survives native commit acknowledgement loss and serves its exact committed bytes",
      "suite": "functional"
    },
    "intendedFailure": "ACK link draft: committed bytes remain readable"
  },
  {
    "set": "controls-ack-link-refusal",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9a a remembered-link draft survives native commit acknowledgement loss and serves its exact committed bytes",
      "suite": "functional"
    },
    "intendedFailure": "ACK link draft: its own durable commit is acknowledged with 200"
  },
  {
    "set": "controls-ack-dedup-mirror",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9d deduplicated draft publication survives native commit acknowledgement loss and completes retirement",
      "suite": "functional"
    },
    "intendedFailure": "ACK draft-dedup: success refreshes the live epoch mirror"
  },
  {
    "set": "controls-ack-dedup-later",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9f deduplicated publication acknowledges its retirement after a later publication and draft save",
      "suite": "functional"
    },
    "intendedFailure": "ACK later dedup: the original committed retirement is acknowledged"
  },
  {
    "set": "controls-ack-link-later",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9h a remembered-link save acknowledges its commit after a later editor saves another draft",
      "suite": "functional"
    },
    "intendedFailure": "ACK later link: the original committed save is acknowledged"
  },
  {
    "set": "controls-ack-thumb-later-bytes",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9g a thumbnail acknowledges its committed upload and finishes obsolete cleanup after a later publication and thumbnail replace it",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb later: the newer thumbnail JPEG remains readable"
  },
  {
    "set": "controls-ack-thumb-later-head",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9g a thumbnail acknowledges its committed upload and finishes obsolete cleanup after a later publication and thumbnail replace it",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb later: the newer publication remains current"
  },
  {
    "set": "controls-ack-thumb-later-response",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9g a thumbnail acknowledges its committed upload and finishes obsolete cleanup after a later publication and thumbnail replace it",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb later: the first committed upload still answers 200"
  },
  {
    "set": "controls-ack-thumb-later-retirement",
    "target": {
      "spec": "e2e/specs/functional/a12-versions.spec.mjs",
      "case": "A12.9g a thumbnail acknowledges its committed upload and finishes obsolete cleanup after a later publication and thumbnail replace it",
      "suite": "functional"
    },
    "intendedFailure": "ACK thumb later: the first upload finishes its original obsolete-version cleanup"
  },
  {
    "set": "controls-operator-access-ack",
    "target": {
      "spec": "e2e/specs/functional/a12-operator-ack.spec.mjs",
      "case": "A12.10c an operator access grant ACK retry preserves a later real revocation and its mirrors",
      "suite": "functional"
    },
    "intendedFailure": "^ACK operator access: original retry preserves"
  },
  {
    "set": "controls-operator-withdraw-later-ack",
    "target": {
      "spec": "e2e/specs/functional/a12-operator-ack.spec.mjs",
      "case": "A12.10d an operator withdrawal ACK retry finishes captured cleanup while preserving a later publication",
      "suite": "functional"
    },
    "intendedFailure": "^ACK operator withdrawal later head: exact captured retirement"
  },
  {
    "set": "controls-ack-thread-reopen",
    "target": {
      "spec": "e2e/specs/functional/a07-thread-ack.spec.mjs",
      "case": "A7.8 a thread resolution acknowledges its committed note after native ACK loss without undoing a later reopen",
      "suite": "functional"
    },
    "intendedFailure": "ACK thread: retry preserves the later reopen and both original notes"
  },
  {
    "set": "controls-ack-suggestion-create",
    "target": {
      "spec": "e2e/specs/functional/a08-suggestion-ack.spec.mjs",
      "case": "A8.10a suggestion creation acknowledges its single committed annotation after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK suggestion create: its own durable annotation is acknowledged with 200"
  },
  {
    "set": "controls-ack-suggestion-revise",
    "target": {
      "spec": "e2e/specs/functional/a08-suggestion-ack.spec.mjs",
      "case": "A8.10b suggestion revision records exactly one history entry after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK suggestion revise: native retry records exactly one history entry"
  },
  {
    "set": "controls-ack-suggestion-claim-replay",
    "target": {
      "spec": "e2e/specs/functional/a08-suggestion-lease-ack.spec.mjs",
      "case": "A8.11a a completed suggestion claim does not resurrect a lease released before its native retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK suggestion claim: native retry preserves the later lease operation"
  },
  {
    "set": "controls-ack-suggestion-release-replay",
    "target": {
      "spec": "e2e/specs/functional/a08-suggestion-lease-ack.spec.mjs",
      "case": "A8.11b a completed suggestion release does not erase a newer same-account lease before its native retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK suggestion release: native retry preserves the later lease operation"
  },
  {
    "set": "controls-ack-verification-mail",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11a a verification reservation survives native acknowledgement loss and mails its current code exactly once",
      "suite": "functional"
    },
    "intendedFailure": "ACK verification start: its reserved code is mailed exactly once"
  },
  {
    "set": "controls-ack-verification-start",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11a a verification reservation survives native acknowledgement loss and mails its current code exactly once",
      "suite": "functional"
    },
    "intendedFailure": "ACK verification start: its durable reservation returns200"
  },
  {
    "set": "controls-ack-verification-final",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11b a wrong verification request spends one guess through native acknowledgement loss including the final slot",
      "suite": "functional"
    },
    "intendedFailure": "ACK wrong code 4: its completed attempt retains the original refusal"
  },
  {
    "set": "controls-ack-verification-first",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11b a wrong verification request spends one guess through native acknowledgement loss including the final slot",
      "suite": "functional"
    },
    "intendedFailure": "ACK wrong code 0: one request spends one guess"
  },
  {
    "set": "controls-ack-verification-replaced",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11c a retried wrong code cannot spend a replacement challenge's guess budget",
      "suite": "functional"
    },
    "intendedFailure": "ACK replacement: the original checked challenge changed"
  },
  {
    "set": "controls-ack-reading-member",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11d member and public reading beats consume their five-minute cap once after native acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK reading member: one request consumes one cap"
  },
  {
    "set": "controls-ack-reading-public",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11d member and public reading beats consume their five-minute cap once after native acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK reading public: one request consumes one cap"
  },
  {
    "set": "controls-ack-team-cleanup",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11e an administrator acknowledges self-removal after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK team: completed request clears its temporary receipt"
  },
  {
    "set": "controls-ack-team-self-removal",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11e an administrator acknowledges self-removal after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK team: self-removal acknowledges the completed authorized change"
  },
  {
    "set": "controls-ack-team-invitation",
    "target": {
      "spec": "e2e/specs/functional/a12-endpoint-ack.spec.mjs",
      "case": "A12.11f a committed team addition keeps its invitation delta through native acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK team: the winning addition sends exactly one invitation"
  },
  {
    "set": "controls-ack-folder-invitation",
    "target": {
      "spec": "e2e/specs/functional/a14-membership-ack.spec.mjs",
      "case": "A14.8a a folder grant ACK retry retains its invitation delta without regranting access revoked by a later request",
      "suite": "functional"
    },
    "intendedFailure": "ACK folder membership: original invitation delta sends exactly one message"
  },
  {
    "set": "controls-ack-folder-replay",
    "target": {
      "spec": "e2e/specs/functional/a14-membership-ack.spec.mjs",
      "case": "A14.8a a folder grant ACK retry retains its invitation delta without regranting access revoked by a later request",
      "suite": "functional"
    },
    "intendedFailure": "ACK folder membership: original retry preserves the later revocation and exact events"
  },
  {
    "set": "controls-ack-doc-invitation",
    "target": {
      "spec": "e2e/specs/functional/a14-membership-ack.spec.mjs",
      "case": "A14.8b a document grant ACK retry retains its invitation and one event without regranting access revoked by a later request",
      "suite": "functional"
    },
    "intendedFailure": "ACK doc membership: original invitation delta sends exactly one message"
  },
  {
    "set": "controls-ack-doc-replay",
    "target": {
      "spec": "e2e/specs/functional/a14-membership-ack.spec.mjs",
      "case": "A14.8b a document grant ACK retry retains its invitation and one event without regranting access revoked by a later request",
      "suite": "functional"
    },
    "intendedFailure": "ACK doc membership: original retry preserves the later revocation and exact events"
  },
  {
    "set": "controls-ack-rename-replay",
    "target": {
      "spec": "e2e/specs/functional/a14-rename-ack.spec.mjs",
      "case": "A14.9 a rename acknowledges its own native commit without overwriting a later rename or duplicating its change event",
      "suite": "functional"
    },
    "intendedFailure": "ACK rename: original retry preserves the newer title and exact two events"
  },
  {
    "set": "controls-ack-mcp-comment",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7a MCP add_comment acknowledges one committed thread after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP comment: the original call acknowledges its durable thread"
  },
  {
    "set": "controls-ack-mcp-read",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7b overlapping MCP get_document calls count each committed read once after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP read: overlapping native retries count each session read once"
  },
  {
    "set": "controls-ack-mcp-read-aggregate",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7b overlapping MCP get_document calls count each committed read once after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP read: overlapping native retries count each aggregate read once"
  },
  {
    "set": "controls-ack-mcp-read-cleanup",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7b overlapping MCP get_document calls count each committed read once after native transaction acknowledgement loss",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP read: successful calls remove only their completed receipts"
  },
  {
    "set": "controls-ack-mcp-deleted-cleanup",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7c MCP add_comment acknowledges its commit without resurrecting feedback an author deletes before the native retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP author deletion: the completed request removes its bounded receipt"
  },
  {
    "set": "controls-ack-mcp-deleted-result",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7c MCP add_comment acknowledges its commit without resurrecting feedback an author deletes before the native retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP author deletion: the committed creation still succeeds"
  },
  {
    "set": "controls-ack-mcp-deleted-resurrection",
    "target": {
      "spec": "e2e/specs/functional/a20-mcp-ack.spec.mjs",
      "case": "A20.7c MCP add_comment acknowledges its commit without resurrecting feedback an author deletes before the native retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK MCP author deletion: the native retry never resurrects deleted feedback"
  },
  {
    "set": "controls-ack-cli-oauth",
    "target": {
      "spec": "e2e/specs/functional/a20-oauth-ack.spec.mjs",
      "case": "A20.oauth-ack the CLI first code exchange survives native ACK loss with one usable token while an independent replay still revokes it",
      "suite": "functional"
    },
    "intendedFailure": "ACK CLI OAuth: the first exchange acknowledges its committed token"
  },
  {
    "set": "controls-ack-dcr-oauth",
    "target": {
      "spec": "e2e/specs/functional/a20-oauth-ack.spec.mjs",
      "case": "A20.oauth-ack-dcr a native code retry cannot revoke a later refreshed grant while independent code replay still can",
      "suite": "functional"
    },
    "intendedFailure": "ACK DCR OAuth: own retry preserves the newer unrevoked generation"
  },
  {
    "set": "controls-ack-comment-cooldown",
    "target": {
      "spec": "e2e/specs/functional/a23-cooldown-ack.spec.mjs",
      "case": "A23.8a a comment cooldown claim surviving native ACK loss still delivers its winning notice exactly once",
      "suite": "functional"
    },
    "intendedFailure": "ACK comment cooldown: the winning committed claim delivers exactly one notice"
  },
  {
    "set": "controls-ack-suggestion-cooldown",
    "target": {
      "spec": "e2e/specs/functional/a23-cooldown-ack.spec.mjs",
      "case": "A23.8b a suggestion cooldown claim surviving native ACK loss still delivers its winning notice exactly once",
      "suite": "functional"
    },
    "intendedFailure": "ACK suggestion cooldown: the winning committed claim delivers exactly one notice"
  },
  {
    "set": "controls-ack-cooldown-expiry",
    "target": {
      "spec": "e2e/specs/functional/a23-cooldown-ack.spec.mjs",
      "case": "A23.8c a reader whose document expires while its committed cooldown ACK is held receives no comment bytes after retry",
      "suite": "functional"
    },
    "intendedFailure": "ACK cooldown expiry: the expired reader receives no private comment notice"
  }
];
const nativeCells = [
  "native-ack-endpoints",
  "native-ack-operators",
  "native-ack-feedback-threads",
  "native-ack-suggestions",
  "native-ack-suggestion-leases",
  "native-ack-verification-views-teams",
  "native-ack-membership",
  "native-ack-rename",
  "native-ack-mcp",
  "native-ack-oauth",
  "native-ack-email-cooldown"
];
const nativeId = "native-transaction-ack-loss-misclassifies-own-commit";
const commandIds = ["rtdb-rule-coverage-retains-live-payloads", "early-e2e-report-accepted-as-completed-run"];
expected.push({
  "id": "firestore-rule-coverage-retains-live-payloads",
  "claim": "The pinned Firestore emulator retained evaluated rule values between scenarios and exhausted its fixed 2048 MB heap during the ten-editor full-file run. Preserve the interrupted result, archive coverage, and replace only the diagnostic tracker with an identical-rule reapply at verified quiescent exclusive boundaries. Fresh complete runs must establish recovery.",
  "requiredCases": []
});
commandIds.push("firestore-rule-coverage-retains-live-payloads");

expected.push({
  "id": "firestore-orphaned-listen-queues",
  "claim": "A live heap dump after GC retained about 1.48 GB in WebChannel envelopes. The pinned emulator Listen close callback does not unsubscribe its database listener, and transport termination alone returns HTTP 200 while queues continue growing. At the existing exclusive idle boundary, remove only observed subscriptions, drain removal confirmations, acknowledge buffered envelopes and terminate; preserve actual race timing and database state.",
  "requiredCases": []
});
commandIds.push("firestore-orphaned-listen-queues");

expected.push({
  "id": "c7-stale-draft-admission",
  "claim": "C7 required unconditional Shared during staggered admission even when a peer autosave changed the draft between preparing the editing session and loading its pinned iframe. The documented 409 remains non-editable and offers Reload draft; exercise that explicit recovery before typing while preserving all convergence, token and draft oracles.",
  "requiredCases": [
    {
      "caseId": "e2e/specs/concurrency/c05-structure.spec.mjs::C7 a ~300 KB document with staggered joins: every peer shown as Shared receives the others' keystrokes, and every copy converges with every token once (no silent divergence over the live log's 2MiB bound)",
      "n": 2
    },
    {
      "caseId": "e2e/specs/concurrency/c05-structure.spec.mjs::C7 a ~300 KB document with staggered joins: every peer shown as Shared receives the others' keystrokes, and every copy converges with every token once (no silent divergence over the live log's 2MiB bound)",
      "n": 5
    },
    {
      "caseId": "e2e/specs/concurrency/c05-structure.spec.mjs::C7 a ~300 KB document with staggered joins: every peer shown as Shared receives the others' keystrokes, and every copy converges with every token once (no silent divergence over the live log's 2MiB bound)",
      "n": 10
    },
    {
      "caseId": "e2e/specs/concurrency/c05-structure.spec.mjs::C7 a ~300 KB document with staggered joins: every peer shown as Shared receives the others' keystrokes, and every copy converges with every token once (no silent divergence over the live log's 2MiB bound)",
      "n": 20
    }
  ]
});

expected.push({
  "id": "c6-delayed-done-safe-refusal",
  "claim": "The C6 serial latency control assumed Done must close immediately below ten seconds of injected per-batch delay. At N=10, six-second delayed batches cumulatively exceeded the delivery deadline and the product correctly retained the editor with an explicit retry message. Exercise its single bounded retry after draining the transport window while preserving every save, token, body, presence and convergence assertion.",
  "requiredCases": [
    {
      "caseId": "e2e/specs/concurrency/c06-leave-commit.spec.mjs::C6 latency serial control: under the same delay, each editor in turn types, presses Done inside the debounce and waits for its last token at every other peer; then the agent's commit_draft: nobody stays in the editor, the live log is empty, the version is clean and holds every token once (I2) and every peer's body (I5), and status/{d}/peers empties within 5 s (I12)",
      "n": 10
    }
  ]
});

const hosted404 = {
  "id": "hosting-404-preview-evidence",
  "claim": "Local Hosting cannot reproduce production-added cache headers. Preserve the production-only case skip while checking its exact seven absent-document probes through the real same-project Hosting preview.",
  "requiredCases": []
};
expected.splice(expected.findIndex(row => row.id === 'mcp-real-runtime-parse-headers') + 1, 0, hosted404);
commandIds.push(hosted404.id);

expected.push({
  "id": "firestore-handshake-navigation",
  "claim": "Chromium discards a completed Firestore handshake response body after navigation, so idle cleanup cannot recover its session identity and correctly refuses to continue. Enable bounded durable inspector response capture before each primary or secondary page navigates; retain fail-closed cleanup and all application request timing.",
  "requiredCases": []
});
commandIds.push("firestore-handshake-navigation");

expected.push({
  "id": "mint-race-response-deadlock",
  "claim": "The C8 late-loser test awaited a browser release that also waited for the HTTP response while deliberately holding that response at a server gate. Dispatch requests, verify gate arrivals, release gates, then drain responses; retain all publication, stale-base and fresh-draft assertions.",
  "requiredCases": [
    {
      "caseId": "e2e/specs/concurrency/c08-mint-races.spec.mjs::C8 S4b a late losing Save as new version (SYNC-P): commits held before they read the draft, the first published (deleting its draft), the losers let go to read it and held again while a fresh draft is saved on the new version; every loser is told of the newer version and the fresh draft survives",
      "n": 2
    },
    {
      "caseId": "e2e/specs/concurrency/c08-mint-races.spec.mjs::C8 S4b a late losing Save as new version (SYNC-P): commits held before they read the draft, the first published (deleting its draft), the losers let go to read it and held again while a fresh draft is saved on the new version; every loser is told of the newer version and the fresh draft survives",
      "n": 5
    },
    {
      "caseId": "e2e/specs/concurrency/c08-mint-races.spec.mjs::C8 S4b a late losing Save as new version (SYNC-P): commits held before they read the draft, the first published (deleting its draft), the losers let go to read it and held again while a fresh draft is saved on the new version; every loser is told of the newer version and the fresh draft survives",
      "n": 10
    }
  ]
});


expected.push({
  "id": "resume-browser-shutdown-boundary",
  "claim": "Concurrent pool close callers could return before browser exit, shutdown errors were swallowed, and a renderer waiting for memory could launch after shutdown. Await shared shutdown and refuse later measurement after an unsafe maintenance boundary.",
  "requiredCases": []
});
commandIds.push("resume-browser-shutdown-boundary");

expected.push({
  "id": "resume-integrated-control-preflight",
  "claim": "Integrated OAuth declarations contained duplicate bindings and stale capability disclosure; mutation patches drifted from current source and the staged Hosting configuration. Reject invalid syntax before startup and validate independent controls with their declared overlays and refreshed disclosure oracles.",
  "requiredCases": []
});
commandIds.push("resume-integrated-control-preflight");

expected.push({
  "id": "resume-cloud-participant-scope",
  "claim": "Cloud qualification still demanded twenty-participant trials after local acceptance adopted the reviewed ten-participant cap. Share the exact validated scope while retaining every N2/N5/N10 trial and the original unscoped matrix.",
  "requiredCases": []
});
commandIds.push("resume-cloud-participant-scope");

expected.push({
  "id": "resume-print-baseline-settle",
  "claim": "The print comparison baseline relied on screenshot timing to include two animation frames after element removal. The Playwright-matched browser exposed an unpainted baseline. Explicitly settle after removal and retain the same pixel assertion.",
  "requiredCases": []
});
commandIds.push("resume-print-baseline-settle");

expected.push({
  "id": "resume-response-delay-deadline",
  "claim": "A response-delay timer could wake just before its requested duration. Recheck a monotonic deadline before releasing a completed backend response, while preserving explicit restore and request ordering.",
  "requiredCases": []
});
commandIds.push("resume-response-delay-deadline");

expected.push({
  "id": "resume-accessibility-touch-fixture",
  "claim": "A fresh Chromium blank document could retain desktop pointer media despite a touch context. Navigate the synthetic accessibility fixture before checking its touch identity and preserve every product target-size and focus assertion.",
  "requiredCases": []
});
commandIds.push("resume-accessibility-touch-fixture");

const row = id => campaign.discoveries.find(r => r.id === id);
test("all 39 discoveries retain their identities and original claims", () => {
  assert.deepEqual(campaign.discoveries.map(r => r.id), expected.map(r => r.id), "discovery identity and order retention");
  for (const original of expected) assert.equal(row(original.id).claim, original.claim, `${original.id}: original discovery claim retention`);
});
test("26 non-native discoveries retain every exact affected case and N-axis cell", () => {
  const cases = expected.filter(r => r.id !== nativeId && !commandIds.includes(r.id));
  for (const original of cases) assert.deepEqual(row(original.id).requiredCases, original.requiredCases, `${original.id}: exact affected case and N-axis retention`);
});
test("candidate cleanup scope extension preserves the original version-candidate provenance and both new CAS observations", () => {
  const actual = row("refused-upload-leaves-unreachable-bundle");
  assert.deepEqual(actual.scopeExtension, candidateProvenance.scopeExtension, "candidate cleanup exact reviewed CAS extension retention");
  assert.deepEqual(actual.controls, candidateProvenance.controls, "candidate cleanup exact original and added control retention");
  assert.equal(actual.sourceCommit, candidateProvenance.sourceCommit, "candidate cleanup original source commit retention");
  assert.deepEqual(actual.evidence.slice(0,candidateProvenance.evidence.length), candidateProvenance.evidence, "candidate cleanup original evidence retention");
});
test("the native ACK discovery retains 34 cases, 55 controls and 11 whole-file capabilities", () => {
  const original = expected.find(r => r.id === nativeId), actual = row(nativeId);
  assert.deepEqual(actual.requiredCases, original.requiredCases, "native ACK exact affected case retention");
  assert.deepEqual(actual.controls, nativeControls, "native ACK control retention");
  assert.deepEqual(campaign.acceptance.requirements.filter(r => r.id.startsWith("native-ack-")).map(r => r.id), nativeCells, "native ACK whole-file capability retention");
});
test("command-only harness or deployment discoveries explicitly retain empty case obligations", () => {
  for (const id of commandIds) assert.deepEqual(row(id).requiredCases, [], `${id}: explicit command-only case boundary`);
});
