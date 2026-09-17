// SPDX-License-Identifier: Apache-2.0
// The slide navigator: thumbnails, add, reorder, delete (SPEC §6a).

import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";

/**
 * There is no slide MODEL.
 *
 * A "slide" is a top-level id-bearing section of the authored document, and
 * every operation here is a plain DOM edit through the same autosave path as
 * typing. That is what keeps a deck and a prose document the same kind of
 * thing — and it is why reordering slides cannot corrupt a document that was
 * never a deck.
 */

interface Slide {
  id: string;
  title: string;
  element: HTMLElement;
}

function readSlides(doc: Document): Slide[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("body > section[id], body > article[id]")).map(
    (element, i) => ({
      id: element.id,
      title:
        element.querySelector("h1, h2, h3")?.textContent?.trim() ||
        element.id ||
        `Slide ${i + 1}`,
      element,
    }),
  );
}

export function SlidePanel({
  doc,
  epoch,
  editable,
  drawerOpen,
  onChanged,
}: {
  doc: Document | null;
  epoch: number;
  editable: boolean;
  drawerOpen?: boolean;
  /** Fires after any structural edit, so the caller can mark the draft dirty. */
  onChanged: () => void;
}) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [current, setCurrent] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);

  const refresh = useMemo(
    () => () => setSlides(doc ? readSlides(doc) : []),
    [doc],
  );

  useEffect(refresh, [refresh, epoch]);

  /** Highlight whichever section is in view. */
  useEffect(() => {
    if (!doc || slides.length === 0) return;
    const observer = new (doc.defaultView?.IntersectionObserver ?? IntersectionObserver)(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slides.findIndex((s) => s.element === entry.target);
          if (index >= 0) setCurrent(index);
        }
      },
      { threshold: 0.5 },
    );
    for (const slide of slides) observer.observe(slide.element);
    return () => observer.disconnect();
  }, [doc, slides]);

  if (!doc || slides.length < 2) return null;

  const move = (from: number, to: number) => {
    if (from === to || !doc) return;
    const moving = slides[from].element;
    const target = slides[to].element;
    // insertBefore against the live DOM, so the edit goes through the same
    // input listener and the same autosave as every other change.
    if (from < to) target.after(moving);
    else target.before(moving);
    refresh();
    onChanged();
  };

  const addAfter = (index: number) => {
    if (!doc) return;
    const section = doc.createElement("section");
    // A fresh id that cannot collide, because ids here are anchor scopes: two
    // sections sharing one would silently merge their comment threads.
    section.id = `section-${Date.now().toString(36)}`;
    const heading = doc.createElement("h2");
    heading.textContent = "New section";
    section.appendChild(heading);
    slides[index].element.after(section);
    refresh();
    onChanged();
  };

  return (
    <div className="slide-rail" data-drawer={drawerOpen ? "open" : undefined}>
      {slides.map((slide, i) => (
        <button
          key={slide.id || i}
          type="button"
          className="slide-thumb"
          aria-current={current === i}
          draggable={editable}
          data-dragging={dragging === i}
          onClick={() => slide.element.scrollIntoView({ behavior: "smooth", block: "start" })}
          onDragStart={() => setDragging(i)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragging != null) move(dragging, i);
            setDragging(null);
          }}
        >
          <span className="slide-thumb-index">{i + 1}</span>
          <span className="slide-thumb-title">{slide.title}</span>
          {editable ? (
            <span className="slide-thumb-actions">
              <button
                type="button"
                className="icon-btn btn-sm"
                aria-label={`Add a section after ${slide.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  addAfter(i);
                }}
              >
                <Icon name="plus" size={13} />
              </button>
              <button
                type="button"
                className="icon-btn btn-sm"
                aria-label={`Delete ${slide.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // No confirmation: this is an undoable DOM edit inside a
                  // draft, and the draft is not a version until it is committed.
                  slide.element.remove();
                  refresh();
                  onChanged();
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </span>
          ) : null}
        </button>
      ))}
      {editable ? (
        <button
          type="button"
          className="slide-add"
          onClick={() => addAfter(slides.length - 1)}
        >
          <Icon name="plus" size={14} /> Add a section
        </button>
      ) : null}
    </div>
  );
}
