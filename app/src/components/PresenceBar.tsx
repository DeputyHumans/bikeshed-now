// SPDX-License-Identifier: Apache-2.0
// Who else is here, and where they are looking (SPEC §16).

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { chipsThatFit } from "./presenceFit";
import type { Peer } from "../presence";

/**
 * One colour per person, and the SAME colour everywhere.
 *
 * The value here also paints the live caret, the scroll-rail marker, the
 * comment thread accent and the edge of each persisted highlight, so a person
 * can be traced across five surfaces at a glance. It is derived from their
 * address rather than assigned on join, so it is the same tomorrow and on a
 * different device.
 *
 * Colour is never the ONLY signal: the chip carries a name, and mode is
 * encoded by dot SHAPE — round for reading, square for editing — so somebody
 * who cannot distinguish two hues still gets both facts.
 *
 * One line, whole names, and never a scrollbar. The bar shows as many chips as
 * fit beside the rest of the toolbar, each with the person's full name, and
 * folds the others into a "+N" button that lists them. It used to be a
 * sideways-scrolling row whose names were cut at 12 characters and wrapped
 * inside a chip one line tall, which put a scrollbar on the bar and half a
 * name in each chip; on a phone the row pushed Edit off the screen (S29).
 *
 * A folded chip stays in the page, invisible and out of the tab order, rather
 * than leaving it: it keeps its width, so the fold is measured against widths
 * that do not change with the fold, and the "+N" button's slot is always
 * there for the same reason. The bar's size therefore never depends on what it
 * folded, and it cannot oscillate.
 */
export function PresenceBar({
  peers,
  following,
  onToggleFollow,
}: {
  peers: Peer[];
  following: string | null;
  onToggleFollow: (uid: string) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(peers.length);
  // What a chip's width depends on: who, under what name, in which mode.
  // Not the whole peer, whose scroll position changes several times a second.
  const layoutKey = peers.map((peer) => `${peer.uid}\u0000${peer.name}\u0000${peer.mode}`).join("\u0001");

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const chips = Array.from(bar.querySelectorAll<HTMLElement>(":scope > .presence-chip"));
      const more = bar.querySelector<HTMLElement>(":scope > .presence-more");
      const style = getComputedStyle(bar);
      const inner = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      setShown(
        chipsThatFit(
          chips.map((chip) => chip.offsetWidth),
          parseFloat(style.columnGap) || 0,
          bar.clientWidth > 0 ? inner : 0,
          more?.offsetWidth ?? 0,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The bar for the room it is given; each child for its own width, which
    // changes when a web font arrives.
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    for (const child of Array.from(bar.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [layoutKey]);

  if (peers.length === 0) return null;

  const folded = peers.slice(shown);
  const followed = folded.find((peer) => peer.uid === following);
  const people = (n: number) => (n === 1 ? "1 more person here" : `${n} more people here`);

  return (
    <div ref={barRef} className="presence-bar" role="group" aria-label="People here now">
      {peers.map((peer, index) => (
        <button
          key={peer.uid}
          type="button"
          className="presence-chip"
          data-folded={index >= shown ? "" : undefined}
          style={{ color: peer.color }}
          aria-pressed={following === peer.uid}
          title={
            following === peer.uid
              ? `Following ${peer.name}. Scroll to stop.`
              : `Follow ${peer.name}'s scrolling`
          }
          onClick={() => onToggleFollow(peer.uid)}
        >
          <span className="presence-dot" data-mode={peer.mode} />
          <span className="presence-name">{peer.name}</span>
          {peer.mode === "edit" ? (
            <Icon name="edit" size={12} title="Editing" />
          ) : null}
        </button>
      ))}
      <Menu
        label="More people here"
        entries={folded.map((peer) => ({
          id: peer.uid,
          label: `${following === peer.uid ? "Stop following" : "Follow"} ${peer.name}${peer.mode === "edit" ? " (editing)" : ""}`,
          icon: <span className="presence-dot" data-mode={peer.mode} style={{ color: peer.color }} />,
          onSelect: () => onToggleFollow(peer.uid),
        }))}
        trigger={({ ref, onClick, "aria-expanded": expanded }) => (
          <button
            ref={ref}
            type="button"
            className="presence-more"
            data-idle={folded.length === 0 ? "" : undefined}
            data-following={followed ? "" : undefined}
            style={followed ? { color: followed.color } : undefined}
            aria-haspopup="menu"
            aria-expanded={expanded}
            aria-label={followed ? `${people(folded.length)}, following ${followed.name}` : people(folded.length)}
            title={folded.map((peer) => peer.name).join(", ")}
            onClick={onClick}
          >
            +{folded.length}
          </button>
        )}
      />
    </div>
  );
}
