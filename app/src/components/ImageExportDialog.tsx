// SPDX-License-Identifier: Apache-2.0
// Export a section as PNG, or a diagram as SVG (SPEC §20).

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import {
  describeSvg,
  exportNodePng,
  exportSvg,
  listSvgs,
  type ExportBackground,
} from "../export/image";
import { logEvent } from "../analytics";
import type { Marking } from "../types";

const BACKGROUNDS: { value: ExportBackground; label: string }[] = [
  { value: "transparent", label: "Transparent" },
  { value: "white", label: "White" },
  { value: "surface", label: "Page" },
];

export function ImageExportDialog({
  doc,
  title,
  version,
  user,
  marking,
  onClose,
}: {
  doc: Document | null;
  title: string;
  version: string;
  user: string;
  marking?: Marking;
  onClose: () => void;
}) {
  const toast = useToast();
  const [background, setBackground] = useState<ExportBackground>("white");
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);

  /**
   * Sections are the export unit, because they are also the ANCHOR unit: the
   * thing somebody wants to paste into a deck is the thing they were commenting
   * on. Both are "the nearest id-bearing element".
   */
  const sections = useMemo(
    () =>
      doc
        ? Array.from(doc.querySelectorAll<HTMLElement>("section[id], article[id]"))
        : [],
    [doc],
  );
  const svgs = useMemo(() => (doc ? listSvgs(doc) : []), [doc]);

  const png = async (node: HTMLElement | SVGElement, name: string) => {
    setBusy(true);
    try {
      await exportNodePng(node, {
        background,
        scale,
        name,
        marking,
        title,
        version,
        user,
      });
      logEvent({ name: "export", params: { kind: "png" } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export an image"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Background</span>
        <div className="bg-choices">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.value}
              type="button"
              className="bg-choice"
              data-bg={bg.value}
              aria-label={bg.label}
              aria-pressed={background === bg.value}
              onClick={() => setBackground(bg.value)}
            />
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="export-scale">
          Scale
        </label>
        <select
          id="export-scale"
          className="toolbar-select"
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        >
          <option value={1}>1× — screen</option>
          <option value={2}>2× — retina</option>
          <option value={3}>3× — print</option>
        </select>
      </div>

      <h3>Sections</h3>
      {sections.length === 0 ? (
        <p className="field-hint">
          {/* Not a failure, and worth saying why: the export unit is an
              id-bearing section, and a document without them has nothing to
              offer here. */}
          This document has no id-bearing sections, so there is nothing to export
          piece by piece.
        </p>
      ) : (
        <ul className="activity-feed">
          {sections.map((section, i) => (
            <li key={section.id || i} className="activity-row">
              <span>{section.id || `Section ${i + 1}`}</span>
              <span className="activity-when">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void png(section, `${title}-${section.id || i + 1}`)}
                >
                  PNG
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {svgs.length > 0 ? (
        <>
          <h3 style={{ marginTop: "var(--s-4)" }}>Diagrams</h3>
          <ul className="activity-feed">
            {svgs.map((svg, i) => (
              <li key={i} className="activity-row">
                <span>{describeSvg(svg, i)}</span>
                <span className="activity-when">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void png(svg, `${title}-diagram-${i + 1}`)}
                  >
                    PNG
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      // A vector stays a vector: rasterizing a diagram somebody
                      // will paste into a slide defeats the reason they wanted it.
                      exportSvg(svg, `${title}-diagram-${i + 1}`, marking);
                      logEvent({ name: "export", params: { kind: "svg" } });
                    }}
                  >
                    SVG
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
