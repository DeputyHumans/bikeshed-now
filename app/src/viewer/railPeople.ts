// SPDX-License-Identifier: Apache-2.0
// Who else is on which slide, for the slide rail (SPEC §6d, §16).

import { useMemo } from "react";
import type { RailPerson } from "../components/SlidePanel";
import { personName } from "../people";
import type { Peer } from "../presence";
import { slideOfPeer, type Slide } from "./deck";

/**
 * Each person in the document, on the slide they are on, by the same answer
 * following them uses (`slideOfPeer`). Somebody whose slide cannot be told — a
 * tab on an app that shares none, a place on no slide — is on no slide here,
 * and still in the presence bar.
 *
 * Every presence update gives a new list of peers, most of them a cursor
 * moving or a scroll inside a slide. The map is rebuilt only when what the rail
 * draws changes: who, under what name and colour, in which mode, on which
 * slide. Otherwise it is the same map as before.
 */
export function useRailPeople(peers: readonly Peer[], slides: readonly Slide[], doc: Document | null): ReadonlyMap<number, RailPerson[]> {
  const rows = peers.map((peer) => ({
    uid: peer.uid,
    name: personName({ uid: peer.uid, email: peer.email, known: peer.name }),
    color: peer.color,
    mode: peer.mode,
    slide: slideOfPeer(peer, slides, doc),
  }));
  const key = rows.map((r) => `${r.uid}\u0000${r.name}\u0000${r.color}\u0000${r.mode}\u0000${r.slide}`).join("\u0001");
  return useMemo(() => {
    const bySlide = new Map<number, RailPerson[]>();
    for (const { slide, ...person } of rows) {
      if (slide < 0) continue;
      bySlide.set(slide, [...(bySlide.get(slide) ?? []), person]);
    }
    return bySlide;
    // `rows` is read through `key`, which says everything the map is made of.
  }, [key]);
}
