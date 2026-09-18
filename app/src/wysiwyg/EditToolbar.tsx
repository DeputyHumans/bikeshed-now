// SPDX-License-Identifier: Apache-2.0
// The WYSIWYG toolbar, with a palette that depends on the source format (SPEC §6a, §11).

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { EDITOR_FONT_CHOICES } from "../brand/fonts";
import { TOKENS } from "../brand/tokens";
import type { SourceFormat } from "../types";

/**
 * Why execCommand, a deprecated API
 * ---------------------------------
 * ProseMirror, Slate and Lexical all normalize a document into their own
 * schema. For hand-authored HTML — a deck with inline SVG, a <details> tree, a
 * scroll observer — normalizing is destruction: the document that comes out is
 * not the document that went in, and the round-trip guarantee this product
 * rests on is gone.
 *
 * execCommand is awkward and deprecated. It is also the only API that edits a
 * document in place without first deciding what a document is allowed to
 * contain. See docs/adr/0007.
 */

export type Command =
  | { kind: "block"; value: string }
  | { kind: "exec"; command: string; value?: string };

/**
 * What a control does, and whether Markdown can express it.
 *
 * A control shows EITHER an icon or a short typographic label, never a word.
 * `• List` and `1. List` wrapped onto two lines inside a 34px button — the
 * button cannot grow to fit a word without the toolbar reflowing, so the label
 * has to be the thing that fits. B/I/U/S stay as letters because a letter set
 * in its own style IS the icon for it, everywhere, in every editor ever built.
 */
interface Control {
  id: string;
  /** The typographic label. Omitted when `icon` carries the meaning. */
  label?: string;
  icon?: IconName;
  title: string;
  command: Command;
  /** Absent means every format supports it. */
  formats?: SourceFormat[];
}

const INLINE_CONTROLS: Control[] = [
  { id: "bold", label: "B", title: "Bold", command: { kind: "exec", command: "bold" } },
  { id: "italic", label: "I", title: "Italic", command: { kind: "exec", command: "italic" } },
  {
    id: "underline",
    label: "U",
    title: "Underline",
    command: { kind: "exec", command: "underline" },
    // Markdown has no underline. HTML-authored documents keep it.
    formats: ["html"],
  },
  {
    id: "strike",
    label: "S",
    title: "Strikethrough",
    command: { kind: "exec", command: "strikeThrough" },
  },
  {
    id: "code",
    icon: "code",
    title: "Inline code",
    command: { kind: "exec", command: "formatBlock", value: "code" },
  },
];

const LIST_CONTROLS: Control[] = [
  {
    id: "ul",
    icon: "listBullet",
    title: "Bulleted list",
    command: { kind: "exec", command: "insertUnorderedList" },
  },
  {
    id: "ol",
    icon: "listOrdered",
    title: "Numbered list",
    command: { kind: "exec", command: "insertOrderedList" },
  },
  {
    id: "quote",
    icon: "quote",
    title: "Blockquote",
    command: { kind: "exec", command: "formatBlock", value: "blockquote" },
  },
  {
    id: "hr",
    icon: "rule",
    title: "Horizontal rule",
    command: { kind: "exec", command: "insertHorizontalRule" },
  },
];

const BLOCKS = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
  { value: "h4", label: "Heading 4" },
  { value: "pre", label: "Code block" },
];

/**
 * Controls Markdown cannot express.
 *
 * They are DISABLED with an explanation, never hidden. A control that appears
 * to work and then loses your formatting on save is worse than one that is
 * visibly unavailable; a control that silently disappears leaves the author
 * wondering what they did wrong. The tooltip says which of the two it is.
 */
const MARKDOWN_UNAVAILABLE =
  "Markdown cannot express this, so it would be lost the next time you save. Publish this document as HTML to use it.";

export interface EditToolbarProps {
  /** Which palette to offer. The only difference between the two modes. */
  format: SourceFormat;
  /** The document being edited. Commands are dispatched against it. */
  doc: Document | null;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  saveError?: string | null;
  onCommit: () => void;
  commitDisabled?: boolean;
  commitDisabledReason?: string;
  /**
   * Leave the editor without publishing.
   *
   * This bar REPLACES the viewer's toolbar while editing, so until it existed
   * the only ways out were publishing and navigating away — and publishing is
   * blocked while any comment on the base version is unresolved. An author who
   * opened the editor on a document under review was stuck in it.
   */
  onExit: () => void;
  /**
   * Whether this editor is joined to the shared document.
   *
   * It replaces the `observing` flag the edit lock used to set, and it says
   * something materially different: not "somebody else is typing so you may
   * not", but "your typing is reaching everybody" — or, while joining, "not
   * yet". Nothing here is disabled by it; there is no state in which editing is
   * refused any more.
   */
  sharing?: "off" | "joining" | "shared";
}

function SaveState({
  state,
  error,
}: {
  state: EditToolbarProps["saveState"];
  error?: string | null;
}) {
  const text =
    state === "saving"
      ? "Saving…"
      : state === "saved"
        ? "Saved"
        : state === "dirty"
          ? "Unsaved changes"
          : state === "error"
            ? (error ?? "Could not save")
            : "";
  return (
    <span className="save-state" data-state={state} role="status" aria-live="polite">
      {state === "saving" ? <span className="spinner" /> : null}
      {text}
    </span>
  );
}

export function EditToolbar({
  format,
  doc,
  saveState,
  saveError,
  onCommit,
  commitDisabled,
  commitDisabledReason,
  onExit,
  sharing,
}: EditToolbarProps) {
  const [active, setActive] = useState<Set<string>>(new Set());
  const markdown = format === "markdown";

  const run = useCallback(
    (command: Command) => {
      if (!doc) return;
      doc.defaultView?.focus();
      if (command.kind === "block") {
        doc.execCommand("formatBlock", false, command.value);
      } else {
        doc.execCommand(command.command, false, command.value);
      }
    },
    [doc],
  );

  /** Reflect the caret's current formatting, so the toolbar is not lying. */
  useEffect(() => {
    if (!doc) return;
    const sync = () => {
      const next = new Set<string>();
      for (const id of ["bold", "italic", "underline"]) {
        try {
          if (doc.queryCommandState(id)) next.add(id);
        } catch {
          // queryCommandState throws in some engines for some commands. An
          // un-highlighted button is a smaller problem than a crash.
        }
      }
      setActive(next);
    };
    doc.addEventListener("selectionchange", sync);
    return () => doc.removeEventListener("selectionchange", sync);
  }, [doc]);

  const renderControl = (control: Control) => {
    const unavailable = control.formats && !control.formats.includes(format);
    return (
      <span
        key={control.id}
        className={unavailable ? "toolbar-unavailable" : undefined}
        data-reason={unavailable ? MARKDOWN_UNAVAILABLE : undefined}
      >
        <button
          type="button"
          className="icon-btn toolbar-btn"
          data-control={control.id}
          title={unavailable ? MARKDOWN_UNAVAILABLE : control.title}
          aria-label={control.title}
          aria-pressed={active.has(control.id)}
          disabled={unavailable}
          onClick={() => run(control.command)}
        >
          {control.icon ? <Icon name={control.icon} size={16} /> : control.label}
        </button>
      </span>
    );
  };

  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Formatting">
      <div className="toolbar-group">
        <label className="visually-hidden" htmlFor="bshd-block">
          Block type
        </label>
        <select
          id="bshd-block"
          className="toolbar-select"
          onChange={(e) => run({ kind: "block", value: e.target.value })}
          defaultValue="p"
        >
          {BLOCKS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">{INLINE_CONTROLS.map(renderControl)}</div>
      <div className="toolbar-group">{LIST_CONTROLS.map(renderControl)}</div>

      <div className="toolbar-group">
        <button
          type="button"
          className="icon-btn toolbar-btn"
          title="Link"
          aria-label="Link"
          onClick={() => {
            if (!doc) return;
            // A prompt, not a popover: the browser's own dialog keeps focus and
            // the selection intact, and a custom one in the parent frame would
            // lose the selection inside the iframe the moment it opened.
            const url = doc.defaultView?.prompt("Link to");
            if (url) run({ kind: "exec", command: "createLink", value: url });
          }}
        >
          <Icon name="link" size={16} />
        </button>
      </div>

      {/* Presentation controls. Markdown carries no styling of its own, so
          these are unavailable there rather than silently discarded on save. */}
      <div className="toolbar-group" data-overflow="true">
        <span
          className={markdown ? "toolbar-unavailable" : undefined}
          data-reason={markdown ? MARKDOWN_UNAVAILABLE : undefined}
        >
          <select
            className="toolbar-select"
            aria-label="Font"
            title={markdown ? MARKDOWN_UNAVAILABLE : "Font"}
            disabled={markdown}
            onChange={(e) => run({ kind: "exec", command: "fontName", value: e.target.value })}
            defaultValue={EDITOR_FONT_CHOICES[0].value}
          >
            {EDITOR_FONT_CHOICES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </span>
        <span
          className={markdown ? "toolbar-unavailable" : undefined}
          data-reason={markdown ? MARKDOWN_UNAVAILABLE : undefined}
        >
          <input
            type="color"
            className="toolbar-select"
            aria-label="Text colour"
            title={markdown ? MARKDOWN_UNAVAILABLE : "Text colour"}
            disabled={markdown}
            defaultValue={TOKENS.ink}
            onChange={(e) => run({ kind: "exec", command: "foreColor", value: e.target.value })}
          />
        </span>
        {(["justifyLeft", "justifyCenter"] as const).map((command) => (
          <span
            key={command}
            className={markdown ? "toolbar-unavailable" : undefined}
            data-reason={markdown ? MARKDOWN_UNAVAILABLE : undefined}
          >
            <button
              type="button"
              className="icon-btn toolbar-btn"
              aria-label={command === "justifyLeft" ? "Align left" : "Align centre"}
              title={markdown ? MARKDOWN_UNAVAILABLE : "Alignment"}
              disabled={markdown}
              onClick={() => run({ kind: "exec", command })}
            >
              <Icon
                name={command === "justifyLeft" ? "alignLeft" : "alignCenter"}
                size={16}
              />
            </button>
          </span>
        ))}
      </div>

      {/* One trailing group, so the save state and the two actions are spaced
          as a unit. Left loose in the bar they inherited its 4px control gap,
          which read as the word "Saved" being stuck to the button. */}
      <div className="toolbar-end">
        {sharing && sharing !== "off" ? (
          <span className="share-state" data-state={sharing} role="status" aria-live="polite">
            {sharing === "joining" ? "Joining…" : "Shared"}
          </span>
        ) : null}
        <SaveState state={saveState} error={saveError} />

        {/* Never disabled: the way out of a mode has to work in every state
            the mode can be in, or it is not a way out. The draft survives —
            leaving the editor is not discarding anything. */}
        <button
          type="button"
          className="btn btn-sm btn-keep-label"
          onClick={onExit}
          title="Leave the editor. Your draft is kept, and stays on the document until you publish it."
        >
          Done
        </button>

        <button
          type="button"
          className="btn btn-primary btn-sm btn-keep-label"
          onClick={onCommit}
          disabled={commitDisabled}
          title={commitDisabledReason}
        >
          Save as new version
        </button>
      </div>
    </div>
  );
}

/**
 * Normalize what execCommand produced into what this product stores.
 *
 * `fontSize` emits `<font size="7">`, a presentational element from 1995 that no
 * serializer should be asked to round-trip. Rewriting it to a span with an
 * inline size is the smallest change that keeps the author's intent and leaves
 * the document sane.
 *
 * Exported and pure so the test can construct the nodes directly — jsdom does
 * not implement execCommand, so the only testable half is this one.
 */
export function rewriteLegacyFontTags(root: ParentNode): number {
  const SIZES = ["", "0.7em", "0.85em", "1em", "1.15em", "1.4em", "1.8em", "2.4em"];
  let rewritten = 0;
  for (const font of Array.from(root.querySelectorAll("font"))) {
    const span = font.ownerDocument.createElement("span");
    const size = Number(font.getAttribute("size") ?? "");
    if (size >= 1 && size <= 7) span.style.fontSize = SIZES[size];
    const color = font.getAttribute("color");
    if (color) span.style.color = color;
    const face = font.getAttribute("face");
    if (face) span.style.fontFamily = face;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
    rewritten += 1;
  }
  return rewritten;
}
