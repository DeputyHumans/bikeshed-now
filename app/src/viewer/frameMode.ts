// SPDX-License-Identifier: Apache-2.0
// The one piece of state the document frame is derived from (SPEC §6a, §6c).

/**
 * A DISCRIMINATED UNION, not two booleans.
 *
 * The design this replaces carried `editing` and `frameSandboxed` as
 * independent flags, and three separate effects each guarded themselves with
 * `if (editing) return`. Three independent guards can drift; one union cannot
 * produce a state that does not exist.
 *
 * The important consequence is encoded in the type: EDITING IS ALWAYS
 * SANDBOXED. There is no `sandboxed` field on the editing variant, so "edit an
 * un-sandboxed document" is not a state this app can represent.
 *
 * Why that matters: what an editor edits must be the AUTHORED markup. With the
 * bundle's own JavaScript running, its generated DOM would be serialized as
 * static markup while the generator stayed in place — so every later render
 * appends another copy — and any node the script rewrites on load would
 * silently discard the editor's typed change.
 */
export type FrameMode =
  | { kind: "reading"; versionId: string; draft: boolean; sandboxed: boolean }
  | { kind: "editing"; baseVersion: string; liveEpoch?: string; draftRevision?: string };

/**
 * Whether reading shows the draft rather than the version asked for.
 *
 * An editor reading the published head sees the draft, because that is the
 * document as it now stands. An editor who opens an OLDER version asked for
 * that version: the draft is built on the head, so showing it there answers a
 * question nobody asked, under the older version's label.
 */
export function readsDraft(r: {
  hasDraft: boolean;
  canEdit: boolean;
  shownVersion: string;
  headVersion: string;
}): boolean {
  return r.hasDraft && r.canEdit && r.shownVersion !== "" && r.shownVersion === r.headVersion;
}

/**
 * Whether a reading frame is sandboxed, which is to say its script does not run.
 *
 * A draft never runs: any editor may have written it. An older version never
 * runs either, trusted or not: trust is for the head, the version somebody
 * vouched for, and the server refuses to run any other (SPEC §6c). Only the
 * head, effectively trusted for this reader, runs. A head not yet known is
 * not the head.
 */
export function readingSandboxed(r: {
  draft: boolean;
  trusted: boolean;
  shownVersion: string;
  headVersion: string;
}): boolean {
  const isHead = r.headVersion !== "" && r.shownVersion === r.headVersion;
  return r.draft || !r.trusted || !isHead;
}

/**
 * The iframe's React key.
 *
 * Extracted from an inline template literal that needed three paragraphs of
 * comment to explain. As a named function it can simply be tested.
 *
 * Every input here is something that must cause a REMOUNT rather than an
 * attribute change:
 *
 *   mode      — reading and editing load different URLs and different sandboxes.
 *   sandboxed — the sandbox attribute is read at PARSE time. Changing it on a
 *               live frame does nothing at all, which is the subtlest of these.
 *   trustToken — when a reader grants trust, the frame must reparse so the
 *               previously-blocked scripts finally run.
 *   epoch     — an explicit "reload this" for a draft refresh, since the src may
 *               be byte-identical.
 */
export function frameKey(mode: FrameMode, trustToken: string, epoch: number): string {
  if (mode.kind === "editing") {
    return `edit:${mode.baseVersion}:${mode.liveEpoch ?? "initial"}:${mode.draftRevision ?? "legacy"}:${epoch}`;
  }
  return `read:${mode.versionId}:${mode.draft ? "draft" : "published"}:${
    mode.sandboxed ? "sandboxed" : "trusted"
  }:${trustToken}:${epoch}`;
}

/**
 * The sandbox attribute, or undefined for no sandbox at all.
 *
 * `allow-same-origin` is always present and never negotiable: the parent app
 * drives annotation and editing on `contentDocument`, so a cross-origin frame
 * would break the entire product. What varies is `allow-scripts`, which is the
 * actual security decision — without it, a bundle's JavaScript cannot read this
 * origin's auth token.
 */
export function frameSandbox(mode: FrameMode): string | undefined {
  if (mode.kind === "editing") return "allow-same-origin";
  // Popups, for a link that leaves the document where the viewer hears no
  // clicks and the link must open its own tab (outboundLinks.ts). Safe because
  // every document response is locked by its own header (ADR 0021): a popup of
  // one runs nothing, and only the run variant, with the reader's consent, can.
  return mode.sandboxed ? READING_SANDBOX : undefined;
}

/** The reading frame's sandbox: no `allow-scripts`, ever. */
export const READING_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * The path segment that asks the server to let a document's own script run,
 * after any key: the server's `RUN_SEGMENT` (ADR 0021). Every other content
 * URL is served locked, whatever frame it lands in.
 */
export const RUN_SEGMENT = "!run";

/**
 * The directory a published version's files are read from.
 *
 * An unlisted document's token goes in the PATH, ahead of the document, not in
 * `?k=`. A query string belongs to one URL: the entry got it, and every image
 * and stylesheet the entry names by relative path was requested without it, so
 * a reader with the link but no account got the text and nothing else. A path
 * segment is inherited by every relative reference (SPEC §2, §17). `run` asks
 * for the document's script to run, the same way, for the same reason.
 */
export function contentBase(docId: string, versionId: string, linkToken?: string, run = false): string {
  const key = linkToken ? `~${encodeURIComponent(linkToken)}/` : "";
  return `/content/${key}${run ? `${RUN_SEGMENT}/` : ""}${docId}/${versionId}/`;
}

/** The URL for a mode. Drafts and published versions come from different paths. */
export function frameSrc(
  mode: FrameMode,
  docId: string,
  entry: string,
  epoch: number,
  linkToken?: string,
): string {
  if (mode.kind === "editing") {
    // Cache-busted on the epoch: the draft path is no-store, but a browser that
    // reuses a live document would show the previous save.
    const query = new URLSearchParams({ r: String(epoch) });
    if (mode.draftRevision) {
      query.set("baseVersion", mode.baseVersion);
      query.set("liveEpoch", mode.liveEpoch ?? "initial");
      query.set("draftRevision", mode.draftRevision);
    }
    return `/draft/${docId}/${entry}?${query}`;
  }
  if (mode.draft) return `/draft/${docId}/${entry}?r=${epoch}`;
  // An unsandboxed frame is one that means to run the document's script, and
  // only the run variant can: everything else is served locked (ADR 0021).
  return `${contentBase(docId, mode.versionId, linkToken, !mode.sandboxed)}${entry}`;
}

/**
 * Effective trust for one reader (SPEC §6c).
 *
 * Only `trusted === true`, which a superadmin sets, trusts a document for
 * everyone. An absent flag once meant trusted, for documents older than the
 * flag; it now fails closed, as the server does (ADR 0021).
 */
export function isEffectivelyTrusted(
  docTrusted: boolean | undefined,
  personallyTrusted: boolean,
): boolean {
  return docTrusted === true || personallyTrusted;
}
