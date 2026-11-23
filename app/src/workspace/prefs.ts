// SPDX-License-Identifier: Apache-2.0
// The view choices an account keeps, and this browser's copy of them: the workspace's sort, layouts and filters, the explorer's open or closed and width (SPEC §13, ADR 0041).

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "../auth";
import { saveUserProfile, watchUser } from "../firestore";
import type { AccountView, UserRecord } from "../types";

/**
 * Every view choice, by the name this module and the browser's copy use.
 *
 * They are kept on the account (`users/{uid}.view`, and `explorerOpen` beside
 * it, where ADR 0039 put it first), so they follow the person to every device.
 * The browser keeps a copy only so a page draws right on its first frame: the
 * account is not asked for them, because `useAccountPreferences` already
 * listens to the record for every signed-in page, and a second listener on
 * it costs nothing.
 */
export type ViewChoice =
  | "sort"
  | "layout.folders"
  | "layout.recent"
  | "layout.shared"
  | "recentFilters"
  | "explorerOpen"
  | "explorerWidth";

export const VIEW_CHOICES: readonly ViewChoice[] = [
  "sort",
  "layout.folders",
  "layout.recent",
  "layout.shared",
  "recentFilters",
  "explorerOpen",
  "explorerWidth",
];

export type Layout = "grid" | "list";

export const isLayout = (v: unknown): v is Layout => v === "grid" || v === "list";

/** Where this browser keeps its copy of one account's choices: one entry each, so two accounts on one browser never share them. */
export const cacheKey = (uid: string) => `bshd-view:${uid}`;

/**
 * Where this browser kept each choice before they moved to the account, for
 * whoever was signed in. Read once, written up where the account has nothing
 * yet, then removed.
 */
export const LEGACY_KEYS: Partial<Record<ViewChoice, string>> = {
  sort: "bshd-workspace-sort",
  "layout.folders": "bshd-workspace-layout",
  "layout.recent": "bshd-workspace-layout-recent",
  "layout.shared": "bshd-workspace-layout-shared",
  recentFilters: "bshd-workspace-recent-filters",
};

type Values = Partial<Record<ViewChoice, unknown>>;

/**
 * Storage can be blocked, cleared or absent (a private window, a locked-down
 * browser). Then each choice comes from the account once it answers, and a
 * change lasts as long as the page and the account do.
 */
function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Blocked or full: the account still has it. */
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Blocked: there is nothing to remove. */
  }
}

/** This browser's copy for `uid`, or, before it had one, the choices it kept for everybody. */
function copyFor(uid: string): Values {
  const own = readStored(cacheKey(uid));
  if (own && typeof own === "object" && !Array.isArray(own)) return { ...(own as Values) };
  const legacy: Values = {};
  for (const choice of VIEW_CHOICES) {
    const key = LEGACY_KEYS[choice];
    const value = key ? readStored(key) : undefined;
    if (value !== undefined) legacy[choice] = value;
  }
  return legacy;
}

/** Each choice the account holds. Values are checked where they are used, so one an older or newer client wrote never breaks a page. */
export function choicesOf(record: Partial<UserRecord> | null): Values {
  const view: AccountView = record?.view ?? {};
  const values: Values = {
    sort: view.sort,
    "layout.folders": view.layout?.folders,
    "layout.recent": view.layout?.recent,
    "layout.shared": view.layout?.shared,
    recentFilters: view.recentFilters,
    explorerOpen: record?.explorerOpen,
    explorerWidth: view.explorerWidth,
  };
  for (const choice of VIEW_CHOICES) if (values[choice] === undefined) delete values[choice];
  return values;
}

/** The account fields that hold `choices`, merged into one write. */
export function accountFields(choices: Values): Pick<UserRecord, "view" | "explorerOpen"> {
  const fields: Pick<UserRecord, "view" | "explorerOpen"> = {};
  const view: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};
  for (const [choice, value] of Object.entries(choices) as [ViewChoice, unknown][]) {
    if (choice === "explorerOpen") fields.explorerOpen = value as boolean;
    else if (choice.startsWith("layout.")) layout[choice.slice("layout.".length)] = value;
    else view[choice] = value;
  }
  if (Object.keys(layout).length > 0) view.layout = layout;
  if (Object.keys(view).length > 0) fields.view = view as AccountView;
  return fields;
}

/**
 * This tab's choices for the signed-in account.
 *
 * The tab takes the account's the first time the record reaches it, and from
 * then on keeps its own until it is reloaded: following the record live
 * opened and closed the explorer in every open tab at once (ADR 0039), and a
 * workspace that changed its layout under you because of another device
 * would be the same. A choice made before the account answered stands.
 */
interface Tab {
  uid: string;
  email: string;
  values: Values;
  own: Set<ViewChoice>;
  adopted: boolean;
  stop: (() => void) | null;
}

let tab: Tab | null = null;
/** Signed out: nothing is kept anywhere, and a choice lasts as long as the page. */
let anonymous: Values = {};
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab for `uid`, made from this browser's copy the first time it is asked for. */
function tabFor(uid: string, email: string): Tab {
  if (tab?.uid === uid) {
    tab.email = email || tab.email;
    return tab;
  }
  tab?.stop?.();
  tab = { uid, email, values: copyFor(uid), own: new Set(), adopted: false, stop: null };
  return tab;
}

function adopt(t: Tab, record: Partial<UserRecord> | null) {
  if (tab !== t || t.adopted) return;
  t.adopted = true;
  t.stop?.();
  t.stop = null;
  const held = choicesOf(record);
  const upload: Values = {};
  for (const choice of VIEW_CHOICES) {
    if (t.own.has(choice)) continue;
    if (held[choice] !== undefined) t.values[choice] = held[choice];
    else if (t.values[choice] !== undefined) upload[choice] = t.values[choice];
  }
  // What this browser had that the account does not: a choice made before
  // they moved there, or one whose write never landed.
  if (Object.keys(upload).length > 0) void saveUserProfile(t.uid, t.email, accountFields(upload)).catch(() => {});
  writeStored(cacheKey(t.uid), t.values);
  for (const key of Object.values(LEGACY_KEYS)) removeStored(key);
  notify();
}

function listen(t: Tab) {
  if (t.adopted || t.stop || tab !== t) return;
  // Unreadable: this browser's copy stands, and the next page load asks again.
  const stop = watchUser(t.uid, (record) => adopt(t, record), () => {});
  // The listener may have answered already, from a record another listener holds.
  if (t.adopted || tab !== t) stop();
  else t.stop = stop;
}

function choose(t: Tab, choice: ViewChoice, value: unknown): Promise<boolean> {
  const before = t.values[choice];
  const hadOwn = t.own.has(choice);
  t.values[choice] = value;
  t.own.add(choice);
  writeStored(cacheKey(t.uid), t.values);
  notify();
  return saveUserProfile(t.uid, t.email, accountFields({ [choice]: value })).then(
    () => true,
    () => {
      // A refused write is put back, here and in the copy, unless something
      // newer was chosen in the meantime.
      if (tab === t && t.values[choice] === value) {
        if (before === undefined) delete t.values[choice];
        else t.values[choice] = before;
        if (!hadOwn) t.own.delete(choice);
        writeStored(cacheKey(t.uid), t.values);
        notify();
      }
      return false;
    },
  );
}

/** Every test is a new tab in a new browser session. */
export function forgetViewChoices() {
  tab?.stop?.();
  tab = null;
  anonymous = {};
}

/**
 * One view choice: this tab's, from the account or this browser's copy of it,
 * and a way to change it that writes both. A value this version does not
 * understand reads as `fallback`. The choice may change under a mounted page
 * (one workspace page serves several kinds), and is read again at once.
 *
 * The setter resolves true once the account has it, and false when the
 * account refused it, by which time it has been put back. It never rejects,
 * so a change handler can ignore it.
 */
export function useViewChoice<T>(
  choice: ViewChoice,
  fallback: T,
  valid: (v: unknown) => v is T,
): [T, (next: T) => Promise<boolean>] {
  const { user, gate, emailLower } = useAuth();
  // Every write carries the address, which the rules hold to the record's.
  const uid = gate === "ready" && user && emailLower ? user.uid : null;
  const t = uid ? tabFor(uid, emailLower) : null;
  useEffect(() => {
    if (t) listen(t);
  }, [t]);
  const value = useSyncExternalStore(subscribe, () => (t ? t.values[choice] : anonymous[choice]));
  const set = useCallback(
    (next: T): Promise<boolean> => {
      if (t) return choose(t, choice, next);
      anonymous = { ...anonymous, [choice]: next };
      notify();
      return Promise.resolve(true);
    },
    [t, choice],
  );
  return [valid(value) ? value : fallback, set];
}
