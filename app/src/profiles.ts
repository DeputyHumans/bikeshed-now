// SPDX-License-Identifier: Apache-2.0
// Your own profile: kept in step with your sign-in name, or the name you chose on Account (SPEC §4, ADR 0040).

import { readProfile, saveProfile } from "./firestore";
import { knowName, shortName } from "./people";

/** A name as a provider gives it, short, or null when it gives none or an address. */
function short(name: string | null): string | null {
  if (!name || name.includes("@")) return null;
  return shortName(name) || null;
}

/**
 * On every load of a signed-in account: keep `profiles/{uid}` holding the
 * short form of the name the sign-in provider gives, unless the person chose
 * one on Account, which a sign-in never replaces. Nothing is written when the
 * provider gives no name, or when the stored one already matches.
 */
export async function syncSignInName(uid: string, email: string, providerName: string | null): Promise<void> {
  const signIn = short(providerName);
  const profile = await readProfile(uid);
  if (profile?.chosen) {
    knowName(uid, email, profile.name ?? null);
    return;
  }
  knowName(uid, email, signIn ?? profile?.name ?? null);
  if (signIn && profile?.name !== signIn) await saveProfile(uid, { name: signIn, chosen: false });
}

/**
 * Account's name field. A name typed is kept short and marked chosen; an empty
 * one goes back to the sign-in name, or to none, which shows the address's.
 */
export async function chooseName(uid: string, email: string, typed: string, providerName: string | null): Promise<string | null> {
  const chosen = shortName(typed);
  const name = chosen || short(providerName) || undefined;
  await saveProfile(uid, { name, chosen: Boolean(chosen) });
  knowName(uid, email, name ?? null);
  return name ?? null;
}
