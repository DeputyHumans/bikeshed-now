// SPDX-License-Identifier: Apache-2.0
// The slide navigator: previews, jump, add, reorder, delete (SPEC §6d).

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { SlideThumb } from "./SlideThumb";
import { slideStateTokens } from "../viewer/preview";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Slide, StageSize } from "../viewer/deck";

/** Someone else in the document, as the rail marks them on the slide they are on. */
export interface RailPerson {
  uid: string;
  /** Their short name, as the presence bar shows it. */
  name: string;
  color: string;
  mode: "view" | "edit";
}

/** "Dana K", "Dana K and Sam P", "Dana K, Sam P and Lee T". */
function listNames(people: readonly RailPerson[]): string {
  const names = people.map((p) => p.name);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a slide's spoken name adds for the people on it: their names, or, past two, how many. */
function withPeople(people: readonly RailPerson[]): string {
  if (people.length === 0) return "";
  return people.length <= 2 ? `, with ${listNames(people)}` : `, with ${people.length} people`;
}

/** How many dots a thumb shows before the rest become a count. */
const DOTS = 3;

/**
 * There is still no slide MODEL.
 *
 * A "slide" is a region of the authored document (see `viewer/deck.ts`), and
 * every operation here is a plain DOM edit through the same autosave path as
 * typing. That is what keeps a deck and a prose document the same kind of
 * thing — and it is why reordering slides cannot corrupt a document that was
 * never a deck.
 *
 * The list arrives from `useDeck` rather than being read here, so the rail, the
 * overview and the keyboard all agree about what slide three is.
 */

export function SlidePanel({
  slides,
  current,
  editable,
  drawerOpen,
  baseHref,
  stage,
  onGoTo,
  images,
  onChanged,
  people,
}: {
  slides: Slide[];
  current: number;
  editable: boolean;
  drawerOpen?: boolean;
  baseHref: string;
  stage: StageSize;
  onGoTo: (index: number) => void;
  /** One stored image per slide, from `storedSlideImages`; absent means live previews. */
  images?: string[] | null;
  /** Fires after any structural edit, so the caller can rescan and mark dirty. */
  onChanged: () => void;
  /**
   * Who else is in the document, by the slide they are on (SPEC §6d, §16):
   * a dot in each one's colour on that slide, its shape saying whether they
   * edit, as the presence bar's does, and their names in the slide's own.
   */
  people?: ReadonlyMap<number, readonly RailPerson[]>;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();

  /**
   * Follow the reader. Without this the highlight walks off the bottom of a
   * long deck and stays there, so the rail shows slide one while the document
   * shows slide thirty — a large part of what made it feel broken.
   *
   * `nearest` is the whole point: it is a no-op when the thumb is already in
   * view, so clicking a thumb never yanks the rail out from under the pointer.
   */
  useEffect(() => {
    rail.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [current, reduceMotion]);

  // Read every render rather than memoised on `slides`: a deck's script may
  // set its state after the scan. A string compares equal while it is
  // unchanged, so the previews rebuild only when the deck's state set does.
  const state = slideStateTokens(slides);

  if (slides.length < 2) return null;

  const move = (from: number, to: number) => {
    if (from === to) return;
    const moving = slides[from].outer;
    const target = slides[to].outer;
    // insertBefore against the live DOM, so the edit goes through the same
    // input listener and the same autosave as every other change.
    if (from < to) target.after(moving);
    else target.before(moving);
    onChanged();
  };

  const addAfter = (index: number) => {
    const anchor = slides[index].outer;
    const doc = anchor.ownerDocument;
    const section = doc.createElement("section");
    // A fresh id that cannot collide, because ids here are anchor scopes: two
    // sections sharing one would silently merge their comment threads.
    section.id = `section-${Date.now().toString(36)}`;
    const heading = doc.createElement("h2");
    heading.textContent = "New section";
    section.appendChild(heading);
    anchor.after(section);
    onChanged();
  };

  return (
    <div
      className="slide-rail"
      ref={rail}
      data-drawer={drawerOpen ? "open" : undefined}
    >
      {slides.map((slide, i) => {
        const here = people?.get(i) ?? [];
        return (
        <button
          key={slide.el.id || `${slide.index}-${slide.title}`}
          type="button"
          className="slide-thumb"
          aria-current={current === i}
          aria-label={`Slide ${i + 1}: ${slide.title}${withPeople(here)}`}
          draggable={editable}
          data-dragging={dragging === i}
          data-drop-target={dropTarget === i && dragging !== i ? true : undefined}
          onClick={() => onGoTo(i)}
          onDragStart={() => setDragging(i)}
          onDragEnd={() => {
            setDragging(null);
            setDropTarget(null);
          }}
          // preventDefault is what makes this a valid drop target at all; the
          // state beside it is what tells the reader WHERE the slide will land,
          // which the rail styled for and never actually set.
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={() => setDropTarget(i)}
          onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
          onDrop={() => {
            if (dragging != null) move(dragging, i);
            setDragging(null);
            setDropTarget(null);
          }}
        >
          <SlideThumb slide={slide} baseHref={baseHref} stage={stage} state={state} image={images?.[i]} />
          <span className="slide-thumb-index">{i + 1}</span>
          <span className="slide-thumb-title">{slide.title}</span>
          {here.length > 0 ? (
            <span className="slide-thumb-people" aria-hidden="true" title={listNames(here)}>
              {here.slice(0, DOTS).map((person) => (
                <span key={person.uid} className="presence-dot" data-mode={person.mode} style={{ color: person.color }} />
              ))}
              {here.length > DOTS ? <span className="slide-thumb-people-more">+{here.length - DOTS}</span> : null}
            </span>
          ) : null}
          {editable ? (
            <span className="slide-thumb-actions">
              <span
                role="button"
                tabIndex={0}
                className="icon-btn btn-sm"
                aria-label={`Add a section after ${slide.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  addAfter(i);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.stopPropagation();
                  e.preventDefault();
                  addAfter(i);
                }}
              >
                <Icon name="plus" size={13} />
              </span>
              <span
                role="button"
                tabIndex={0}
                className="icon-btn btn-sm"
                aria-label={`Delete ${slide.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // No confirmation: this is an undoable DOM edit inside a
                  // draft, and the draft is not a version until it is committed.
                  slide.outer.remove();
                  onChanged();
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.stopPropagation();
                  e.preventDefault();
                  slide.outer.remove();
                  onChanged();
                }}
              >
                <Icon name="trash" size={13} />
              </span>
            </span>
          ) : null}
        </button>
        );
      })}
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
