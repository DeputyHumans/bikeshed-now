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
  | { kind: "editing"; baseVersion: string; liveEpoch?: string };

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
    return `edit:${mode.baseVersion}:${epoch}`;
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
  return mode.sandboxed ? "allow-same-origin" : undefined;
}

/**
 * The directory a published version's files are read from.
 *
 * An unlisted document's token goes in the PATH, ahead of the document, not in
 * `?k=`. A query string belongs to one URL: the entry got it, and every image
 * and stylesheet the entry names by relative path was requested without it, so
 * a reader with the link but no account got the text and nothing else. A path
 * segment is inherited by every relative reference (SPEC §2, §17).
 */
export function contentBase(docId: string, versionId: string, linkToken?: string): string {
  const key = linkToken ? `~${encodeURIComponent(linkToken)}/` : "";
  return `/content/${key}${docId}/${versionId}/`;
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
    return `/draft/${docId}/${entry}?r=${epoch}`;
  }
  if (mode.draft) return `/draft/${docId}/${entry}?r=${epoch}`;
  return `${contentBase(docId, mode.versionId, linkToken)}${entry}`;
}

/**
 * Effective trust for one reader (SPEC §6c).
 *
 * Absent `trusted` means trusted: documents published before the flag existed,
 * and documents published by the CLI, are the ones that need their scripts.
 * `false` is the explicit browser-upload case.
 */
export function isEffectivelyTrusted(
  docTrusted: boolean | undefined,
  personallyTrusted: boolean,
): boolean {
  return docTrusted !== false || personallyTrusted;
}
