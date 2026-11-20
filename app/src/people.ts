// SPDX-License-Identifier: Apache-2.0
// How a person is named on screen: a short name, "Pavel S", looked up by uid, never by address (SPEC §16, §17, ADR 0040).

import { useEffect, useSyncExternalStore } from "react";
import type { ProfileRecord } from "./types";

/**
 * People were shown by their address, or by the whole name their sign-in
 * provider gave, which is long and which another reader could not see at
 * all: nothing stored a name, and a person's record is theirs alone. A name
 * now lives in `profiles/{uid}`, which anybody signed in may read by uid and
 * nobody may list, already short. The address is still what identifies
 * somebody, so wherever a name is drawn the address is its tooltip.
 */

/** The longest first word kept, so a name made of one long word still fits a chip. */
const FIRST_MAX = 32;

/**
 * "Pavel Spesivtsev" → "Pavel S": the first word, and the first letter of the
 * last. One word stays as it is. Idempotent, so a name already short, or one a
 * person typed that way, is left alone; every drawn name passes through it, so
 * a long stored value, or an older client's whole name, still draws short.
 */
export function shortName(full: string): string {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = Array.from(words[0]).slice(0, FIRST_MAX).join("");
  if (words.length === 1) return first;
  const initial = Array.from(words[words.length - 1])[0].toLocaleUpperCase();
  return `${first} ${initial}`;
}

/**
 * For somebody with no name anywhere: a password account, or someone who has
 * not opened the app since names arrived. `dana.kim@` → "Dana K", `pavel@` →
 * "Pavel". A `+tag` and parts that are only digits say nothing about a person.
 */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local
    .split("+")[0]
    .split(/[._-]+/)
    .filter((part) => part && !/^\d+$/.test(part));
  if (parts.length === 0) return local || email;
  const capital = (word: string) => word.charAt(0).toLocaleUpperCase() + word.slice(1);
  return shortName(parts.map(capital).join(" "));
}

/** A name as somebody's own client sent it, which an older one sent as an address. */
function usable(name: string | null | undefined): string | null {
  if (!name || name.includes("@")) return null;
  return shortName(name) || null;
}

// --- The session's names -----------------------------------------------------

/**
 * How a profile is read, given once by the app's entry point (main.tsx) and by
 * a test that wants one. Until then nothing is read and every name comes from
 * what is in hand: a component test draws names without reaching a database,
 * and without this module importing the Firestore one at all.
 */
let readProfile: (uid: string) => Promise<ProfileRecord | null> = async () => null;

export function setProfileReader(read: (uid: string) => Promise<ProfileRecord | null>) {
  readProfile = read;
}

/** uid → the profile's name, or null for none; absent until asked for. */
const byUid = new Map<string, string | null>();
/** Learned from a profile: what an email-only record (a draft, a summary) is shown as. */
const byEmail = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask once per session for each uid. A refusal (signed out) is answered as no name. */
function request(uid: string, email: string) {
  if (asked.has(uid)) return;
  asked.add(uid);
  // A read that throws before it starts (no database, say) answers as no name too.
  let read: Promise<{ name?: string } | null>;
  try {
    read = readProfile(uid);
  } catch {
    read = Promise.resolve(null);
  }
  read
    .then((profile) => usable(profile?.name))
    .catch(() => null)
    .then((name) => {
      byUid.set(uid, name);
      if (name) byEmail.set(email, name);
      changed();
    });
}

/** Your own name, as soon as it is known, so the header does not wait on a read. */
export function knowName(uid: string, email: string, name: string | null) {
  const short = usable(name);
  asked.add(uid);
  byUid.set(uid, short);
  if (short) byEmail.set(email, short);
  else byEmail.delete(email);
  changed();
}

/** A new account signed in: what the last one could read is not what this one can. */
export function forgetNames() {
  byUid.clear();
  byEmail.clear();
  asked.clear();
  changed();
}

export interface Named {
  uid?: string | null;
  email: string;
  /** A name already in hand, such as the one a peer's presence carries; the profile still wins. */
  known?: string | null;
}

/** What to call somebody now. Pair with `usePeople` so a name that arrives later redraws. */
export function personName({ uid, email, known }: Named): string {
  return (uid ? byUid.get(uid) : null) ?? usable(known) ?? byEmail.get(email) ?? nameFromEmail(email);
}

/** Asks for everyone given and redraws as their names arrive. */
export function usePeople(people: readonly Named[]): void {
  useSyncExternalStore(subscribe, () => version);
  const key = people.map((p) => `${p.uid ?? ""}\u0000${p.email}`).join("\u0001");
  useEffect(() => {
    for (const p of people) if (p.uid) request(p.uid, p.email);
    // `key` is the list's identity; the array itself is new on every render.
  }, [key]);
}

export function usePersonName(person: Named): string {
  usePeople([person]);
  return personName(person);
}
