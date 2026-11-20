// SPDX-License-Identifier: Apache-2.0
// Who else is here, and where they are looking (SPEC §16).

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { chipsThatFit } from "./presenceFit";
import type { Peer } from "../presence";
import { personName, usePeople } from "../people";

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
 * One line, short names, and never a scrollbar. The bar shows as many chips as
 * fit beside the rest of the toolbar, each with the person's short name,
 * "Pavel S", and folds the others into a "+N" button that lists them; the
 * address is on the second line of the chip's tooltip (ADR 0040). It used to be
 * a sideways-scrolling row whose names were cut at 12 characters and wrapped
 * inside a chip one line tall, which put a scrollbar on the bar and half a
 * name in each chip; on a phone the row pushed Edit off the screen (S29).
 * Whole names then made a chip as wide as a sign-in provider liked.
 *
 * A folded chip stays in the page, invisible and out of the tab order, rather
 * than leaving it: it keeps its width, so the fold is measured against widths
 * that do not change with the fold, and the "+N" button's slot is always
 * there for the same reason. The bar's size therefore never depends on what it
 * folded, and it cannot oscillate.
 *
 * Whoever follows this reader is marked on their chip, with an eye and a wash
 * of their colour, and comes first, so a fold hides them last. Only the person
 * followed sees it; the follower's own chip tells them it is seen. The eye is
 * the signal colour cannot be, and it is read aloud as "Following you".
 */
export function PresenceBar({
  peers: given,
  following,
  onToggleFollow,
}: {
  peers: Peer[];
  following: string | null;
  onToggleFollow: (uid: string) => void;
}) {
  // Each by their short name: the one their profile holds, or the one their
  // presence carries, or their address's.
  usePeople(given.map((peer) => ({ uid: peer.uid, email: peer.email })));
  const peers = followersFirst(given).map((peer) => ({
    ...peer,
    name: personName({ uid: peer.uid, email: peer.email, known: peer.name }),
  }));
  const barRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(peers.length);
  // What a chip's width depends on: who, under what name, in which mode, and
  // whether they follow this reader. Not the whole peer, whose scroll position
  // changes several times a second.
  const layoutKey = peers.map((peer) => `${peer.uid}\u0000${peer.name}\u0000${peer.mode}\u0000${peer.followsYou ? 1 : 0}`).join("\u0001");

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
          data-follows-you={peer.followsYou ? "" : undefined}
          style={{ color: peer.color }}
          aria-pressed={following === peer.uid}
          title={`${chipTitle(peer, following === peer.uid)}\n${peer.email}`}
          onClick={() => onToggleFollow(peer.uid)}
        >
          <span className="presence-dot" data-mode={peer.mode} />
          <span className="presence-name">{peer.name}</span>
          {peer.mode === "edit" ? (
            <Icon name="edit" size={12} title="Editing" />
          ) : null}
          {peer.followsYou ? <Icon name="eye" size={12} title="Following you" /> : null}
        </button>
      ))}
      <Menu
        label="More people here"
        entries={folded.map((peer) => ({
          id: peer.uid,
          label: `${following === peer.uid ? "Stop following" : "Follow"} ${peer.name}${aside(peer)}`,
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

/** Those following this reader first, everyone else after, each in the order given. */
function followersFirst(peers: Peer[]): Peer[] {
  if (!peers.some((peer) => peer.followsYou)) return peers;
  return [...peers.filter((peer) => peer.followsYou), ...peers.filter((peer) => !peer.followsYou)];
}

function chipTitle(peer: Peer, followed: boolean): string {
  const action = followed
    ? `Following ${peer.name}, who can see that you are. Scroll to stop.`
    : `Follow ${peer.name}'s scrolling`;
  return peer.followsYou ? `${peer.name} is following you. ${action}` : action;
}

/** What a folded person's entry adds after their name: " (editing, following you)" and its parts. */
function aside(peer: Peer): string {
  const notes = [peer.mode === "edit" ? "editing" : "", peer.followsYou ? "following you" : ""].filter(Boolean);
  return notes.length ? ` (${notes.join(", ")})` : "";
}
