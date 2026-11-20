// SPDX-License-Identifier: Apache-2.0
// The header's actions on a phone, gathered behind one button (SPEC §7).

import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { usePersonName } from "../people";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";
import { useToast } from "./Toast";

/**
 * An address, Docs, Account and Sign out need about 545 px in a row, and a phone
 * has about 400. Shrinking them is how a wordmark ended up drawn over its own
 * links, so at this width they fold into one button that always fits.
 *
 * `extra` goes first: the document page adds the way back to its folder.
 */
export function AccountMenu({ extra = [] }: { extra?: MenuEntry[] }) {
  const { user, emailLower, gate, signOut } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const signedIn = gate === "ready" && Boolean(user);
  const name = usePersonName({ uid: user?.uid, email: emailLower, known: user?.displayName });

  const entries: MenuEntry[] = [...extra];
  if (signedIn) {
    entries.push(
      // Your name as others see it, and the address it stands for: a phone has
      // no pointer to show the address the header's chip keeps in its tooltip.
      { id: "who", label: name, heading: true },
      { id: "who-address", label: emailLower, heading: true },
      { id: "account", label: "Account", onSelect: () => navigate("/account") },
    );
  } else if (gate !== "loading" && pathname !== "/signup") {
    // Back to this exact place once they have: the version, the link key, the hash.
    entries.push({
      id: "sign-in",
      label: user ? "Finish signing in" : "Sign in",
      onSelect: () => navigate(`/signup?next=${encodeURIComponent(`${pathname}${search}${hash}`)}`),
    });
  }
  // A full page load, never the router: /docs is a Hosting redirect to the
  // published guide, and the SPA's catch-all route would land it on /.
  entries.push({ id: "docs", label: "Docs", onSelect: () => window.location.assign("/docs") });
  if (signedIn) {
    entries.push({
      id: "sign-out",
      label: "Sign out",
      // The menu has closed, so its button cannot say it is busy. Signing out ends
      // the server session first, a round trip that can be slow.
      onSelect: () => {
        toast.during("Signing out…", signOut()).catch(() => toast.error("You\u2019re still signed in. Try again."));
      },
    });
  }

  return (
    <Menu
      label="Menu"
      entries={entries}
      trigger={(props) => (
        <button {...props} type="button" className="icon-btn" aria-label="Menu" aria-haspopup="menu">
          <Icon name="menu" />
        </button>
      )}
    />
  );
}
