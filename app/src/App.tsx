// SPDX-License-Identifier: Apache-2.0
// The app shell and routing (SPEC §7).

import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";

import { useAuth } from "./auth";
import { initAnalytics, logPageView } from "./analytics";
import { CookieConsent } from "./components/CookieConsent";
import { Privacy, Terms } from "./pages/Legal";
import { Header } from "./components/Header";
import { Loading } from "./components/Spinner";
import { DocList } from "./pages/DocList";
import { DocViewer } from "./pages/DocViewer";
import { SignUp } from "./pages/SignUp";
import { Account } from "./pages/Account";

/**
 * Publish the header's MEASURED height as `--header-h`, so every full-height
 * surface subtracts the real value rather than a magic constant — and stays
 * correct as the header condenses on a narrow viewport. A hardcoded 56px is
 * wrong the moment anything inside the header wraps.
 */
function useHeaderHeightVar() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) return;
    const root = document.documentElement;
    const apply = () =>
      root.style.setProperty(
        "--header-h",
        `${Math.round(header.getBoundingClientRect().height)}px`,
      );
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
}

/** Log route changes as PATTERNS. Never the concrete path (SPEC §15). */
function useRouteAnalytics() {
  const location = useLocation();
  useEffect(() => {
    initAnalytics();
  }, []);
  useEffect(() => {
    logPageView(location.pathname);
  }, [location.pathname]);
}

/**
 * The viewer is reachable without an account, because a public or unlinked
 * document is readable without one. Everything else is not.
 *
 * The gate is checked INSIDE the route rather than by wrapping it, so an
 * anonymous reader who follows a link to a public document lands on the
 * document rather than on a sign-in screen they cannot get past.
 */
function RequireAccount({ children }: { children: React.ReactNode }) {
  const { gate } = useAuth();
  if (gate === "loading") return <Loading label="Signing in" />;
  if (gate !== "ready") return <SignUp />;
  return <>{children}</>;
}

/** Redirect a bare /d/:docId once a version is known, so links stay stable. */
function ViewerRoute() {
  const params = useParams();
  return <DocViewer key={`${params.docId}:${params.versionId ?? "current"}`} />;
}

export function App() {
  useHeaderHeightVar();
  useRouteAnalytics();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <Header />
      <main className="main" id="main" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAccount>
                <DocList />
              </RequireAccount>
            }
          />
          <Route
            path="/folder/:folderId"
            element={
              <RequireAccount>
                <DocList />
              </RequireAccount>
            }
          />
          <Route path="/d/:docId" element={<ViewerRoute />} />
          <Route path="/d/:docId/:versionId" element={<ViewerRoute />} />
          <Route path="/signup" element={<SignUp />} />
          <Route
            path="/account"
            element={
              <RequireAccount>
                <Account />
              </RequireAccount>
            }
          />
          {/* Public on purpose: a visitor deciding about cookies must be
              able to read the policy without signing in first. */}
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <CookieConsent />
      </main>
    </div>
  );
}
