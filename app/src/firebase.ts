// SPDX-License-Identifier: Apache-2.0
// Firebase Web SDK initialization, including the emulator wiring (SPEC §12).

import { initializeApp } from "firebase/app";
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectDatabaseEmulator, getDatabase } from "firebase/database";

import { EMULATOR_PORTS, USE_EMULATORS, firebaseConfig } from "./config";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * The Realtime Database is used ONLY for ephemeral presence, and is null-guarded
 * so the app runs without one. Presence then degrades to a clean no-op rather
 * than an error: peer cursors are a feature, not a dependency.
 */
export const rtdb = firebaseConfig.databaseURL ? getDatabase(app) : null;

/**
 * Emulator wiring, behind one flag.
 *
 * This is not a convenience. Without it, `npm run emulators` starts the whole
 * stack while the app quietly talks to the real project — which is what the
 * design this replaces did, and it is the single thing that makes the
 * quickstart cost nothing. Treated as a requirement in SPEC §12.
 */
if (USE_EMULATORS) {
  connectAuthEmulator(auth, `http://127.0.0.1:${EMULATOR_PORTS.auth}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, "127.0.0.1", EMULATOR_PORTS.firestore);
  if (rtdb) connectDatabaseEmulator(rtdb, "127.0.0.1", EMULATOR_PORTS.database);
}

void setPersistence(auth, browserLocalPersistence);

export const googleProvider = new GoogleAuthProvider();
/**
 * `select_account` replaces the hosted-domain hint the single-tenant design
 * used. Without it, a person rejected by a deployment's allowlist clicks
 * "Continue with Google" again, the browser silently reuses the same rejected
 * account, and the screen appears dead — the one failure they cannot diagnose.
 */
googleProvider.setCustomParameters({ prompt: "select_account" });

export const githubProvider = new GithubAuthProvider();
/**
 * `user:email` is REQUIRED, not optional.
 *
 * Without it Firebase receives no address at all for a user who keeps theirs
 * private on GitHub, and this product's entire ACL is a list of lowercased
 * emails: a user with no address cannot be granted anything, so the account is
 * useless the moment it is created (SPEC §14).
 */
githubProvider.addScope("user:email");
