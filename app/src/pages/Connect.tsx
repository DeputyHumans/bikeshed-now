// SPDX-License-Identifier: Apache-2.0
// The consent screen: who is asking, where you go back to, and what it may do (SPEC §23)

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth";
import { Loading } from "../components/Spinner";
import {
  approveRequest,
  clearAuthorizeRequest,
  denyRequest,
  describeRequest,
  displayHost,
  leave,
  safeNavigate,
  type AuthorizeRequest,
  type ConsentInvalid,
  type DecisionResult,
  type DescribeValid,
} from "../oauth";

/**
 * The page decides nothing by itself. The server says who is asking and where
 * the answer goes; this page shows that, waits for a deliberate click, and
 * follows only a redirect back to the exact address the request named.
 *
 * The request arrives as a prop, captured by `ConnectRoute` in App.tsx during
 * render and outside the sign-in gate. That is what lets it survive a sign-in,
 * and "Switch account": this component unmounts while somebody is signed out,
 * and the request waits one level up.
 */

/** How long the page must be visible and focused before Approve works. */
export const ARM_DELAY_MS = 1000;

type View =
  | { kind: "loading" }
  | { kind: "invalid"; message: string; back: string | null }
  | { kind: "ready"; info: DescribeValid }
  | { kind: "leaving"; target: string; loopback: boolean }
  | { kind: "failed"; message: string };

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "That didn't work. Please try again.";
}

/**
 * Approve stays disabled until the page has been visible and focused for a
 * second, and somebody has moved the pointer or pressed a key here.
 *
 * The attack this stops: a page asks for a double click, and between the two
 * clicks it brings this window up under the cursor, so the second click lands
 * on Approve. Losing focus or visibility starts the second again.
 */
function useArmed(active: boolean): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!active) return;
    let touched = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => setArmed(touched && settled);
    const restart = () => {
      clearTimeout(timer);
      settled = false;
      update();
      if (document.visibilityState === "visible" && document.hasFocus()) {
        timer = setTimeout(() => {
          settled = true;
          update();
        }, ARM_DELAY_MS);
      }
    };
    const touch = () => {
      touched = true;
      update();
    };
    restart();
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("focus", restart);
    window.addEventListener("blur", restart);
    window.addEventListener("pointermove", touch);
    window.addEventListener("keydown", touch);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", restart);
      window.removeEventListener("focus", restart);
      window.removeEventListener("blur", restart);
      window.removeEventListener("pointermove", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [active]);
  return armed;
}

function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card connect-card">
        <h1 className="auth-title">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** How the destination reads: a host, this computer, or an app's scheme. */
function destinationOf(info: DescribeValid, redirectUri: string | undefined): string {
  const host = displayHost(redirectUri) || info.redirect.host;
  if (info.redirect.kind === "app") {
    const scheme = info.redirect.scheme.replace(/:$/, "");
    return host && host !== scheme ? `${scheme}://${host}` : `${scheme}:`;
  }
  return host;
}

function Ready({
  info,
  redirectUri,
  armed,
  busy,
  onApprove,
  onCancel,
  onSwitch,
}: {
  info: DescribeValid;
  redirectUri: string | undefined;
  armed: boolean;
  busy: "approve" | "deny" | null;
  onApprove: () => void;
  onCancel: () => void;
  onSwitch: () => void;
}) {
  const { client, redirect, account, device } = info;
  const destination = destinationOf(info, redirectUri);
  const loopback = redirect.kind === "loopback";
  const builtin = client.registration === "builtin";
  // A name is shown as checked only when the server checked the host behind
  // it. Anything else is the app's own description of itself.
  const checked = client.verified && client.registration === "cimd" && Boolean(client.host);
  const unchecked = !builtin && !checked;

  const who = loopback ? (
    "a program on this computer"
  ) : (
    <span className="mono">{destination}</span>
  );

  return (
    <div className="auth-screen">
      <div className="auth-card connect-card">
        {unchecked ? (
          <>
            <h1 className="auth-title">Connect {who} to Bikeshed?</h1>
            <p className="connect-from">
              It calls itself <q className="connect-name">{client.name}</q>{" "}
              <span className="chip chip-warn">chosen by the app, not checked</span>
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Connect {client.name} to Bikeshed?</h1>
            {builtin ? (
              <p className="connect-from">
                Bikeshed's command line
                {device ? (
                  <>
                    {" "}
                    on <strong>{device}</strong>{" "}
                    <span className="self-reported">(as reported by the program)</span>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="connect-from">
                from <strong className="mono">{client.host}</strong>
              </p>
            )}
          </>
        )}

        <div className="connect-destination">
          <span className="field-hint">After you approve, you'll go back to</span>
          <strong className="connect-host mono">{destination}</strong>
        </div>

        {loopback ? (
          <div className="banner banner-warn" role="note">
            <span>
              That's a program on this computer. Approve only if you just started
              it, for example with <code className="mono">bikeshed login</code>.
            </span>
          </div>
        ) : null}
        {unchecked && redirect.kind === "web" ? (
          <div className="banner banner-warn" role="note">
            <span>
              Anyone can register an app under any name. Approve only if you were
              connecting an app at <strong className="mono">{destination}</strong>{" "}
              just now.
            </span>
          </div>
        ) : null}

        <div>
          <h2 className="connect-subhead">As {account.email}, it will be able to</h2>
          <ul className="connect-list">
            <li>Read what you can read</li>
            <li>Publish, revise and rename documents</li>
            <li>Comment, reply, suggest edits and resolve threads</li>
            <li>Accept or reject suggested edits where you can, and save them as a new version</li>
            <li>Create folders and file documents in them</li>
            <li>Manage sharing on documents and folders you own, sending invitations to new readers</li>
            <li>Change visibility, open editing and expiry on documents you own</li>
            <li>Rename and move folders you can edit; delete folders you own while keeping their contents</li>
          </ul>
        </div>
        <div>
          <h2 className="connect-subhead">It won't be able to</h2>
          <ul className="connect-list connect-list-not">
            <li>Delete documents or manage teams</li>
            <li>Trust document scripts or act with permissions you do not have</li>
          </ul>
        </div>

        <p className="field-hint">
          You can disconnect it any time in Account → Access tokens.
        </p>
        <p className="field-hint">
          Signed in as {account.email} ·{" "}
          <button type="button" className="link-btn" disabled={busy !== null} onClick={onSwitch}>
            Switch account
          </button>
        </p>

        {/* Neither button takes focus by itself: a keypress that was meant
            for somewhere else must not land on Approve. */}
        <div className="connect-actions">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            aria-busy={busy === "deny"}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!armed || busy !== null}
            aria-busy={busy === "approve"}
            onClick={onApprove}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

export function Connect({ request }: { request: AuthorizeRequest | null }) {
  const { user, signOut } = useAuth();
  const [framed] = useState(isFramed);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  // The state above disables the buttons on the next render. This stops a
  // second click that arrives before that render does.
  const inFlight = useRef(false);
  const userRef = useRef(user);
  userRef.current = user;
  const uid = user?.uid ?? null;

  const armed = useArmed(view.kind === "ready");

  const idToken = async (): Promise<string> => {
    const current = userRef.current;
    if (!current) throw new Error("Sign in again to continue.");
    return current.getIdToken();
  };

  /** A dead request: say why, and offer the way back only if it is safe. */
  const showInvalid = (result: ConsentInvalid) => {
    clearAuthorizeRequest();
    setView({
      kind: "invalid",
      message: result.message || "This request can't be completed.",
      back: result.back ? safeNavigate(result.back, request?.redirect_uri) : null,
    });
  };

  useEffect(() => {
    if (!request || framed || !uid) return;
    let live = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const result = await describeRequest(request, await idToken());
        if (!live) return;
        if (result.valid) setView({ kind: "ready", info: result });
        else showInvalid(result);
      } catch (e) {
        if (live) setView({ kind: "failed", message: messageOf(e) });
      }
    })();
    return () => {
      live = false;
    };
    // `idToken` reads a ref, and a refreshed token is not a reason to ask again.
  }, [request, framed, uid]);

  const decide = async (action: "approve" | "deny", info: DescribeValid) => {
    if (inFlight.current || !request) return;
    inFlight.current = true;
    setBusy(action);
    try {
      const send = action === "approve" ? approveRequest : denyRequest;
      const result: DecisionResult = await send(request, await idToken());
      if ("redirect" in result) {
        clearAuthorizeRequest();
        const target = safeNavigate(result.redirect, request.redirect_uri);
        if (!target) {
          setView({
            kind: "failed",
            message:
              "The address to go back to didn't match what the app asked for, so Bikeshed stopped here. Nothing was sent to the app.",
          });
          return;
        }
        setView({ kind: "leaving", target, loopback: info.redirect.kind === "loopback" });
        leave(target);
      } else {
        showInvalid(result);
      }
    } catch (e) {
      setView({ kind: "failed", message: messageOf(e) });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  if (framed) {
    return (
      <Card title="Open this page in its own tab">
        <p className="auth-lead">
          Bikeshed won't ask you to approve anything inside another site's page,
          because that page could hide what you're agreeing to.
        </p>
      </Card>
    );
  }

  if (!request) {
    return (
      <Card title="Nothing to connect">
        <p className="auth-lead">
          This page opens when an app asks to connect to your account. Start from
          the app you want to connect. <Link to="/account">Account</Link> shows how
          to add Bikeshed to the usual ones.
        </p>
      </Card>
    );
  }

  switch (view.kind) {
    case "loading":
      return <Loading label="Checking who's asking" />;
    case "invalid":
      return (
        <Card title="This request can't go ahead">
          <p className="auth-lead">{view.message}</p>
          {view.back ? (
            <div className="connect-actions">
              <button type="button" className="btn" onClick={() => leave(view.back as string)}>
                Go back to {displayHost(view.back)}
              </button>
            </div>
          ) : (
            <p className="field-hint">Start again from the app you were connecting.</p>
          )}
        </Card>
      );
    case "failed":
      return (
        <Card title="That didn't work">
          <p className="auth-lead">{view.message}</p>
          <p className="field-hint">Start again from the app you were connecting.</p>
        </Card>
      );
    case "leaving": {
      const host = displayHost(view.target);
      return (
        <Card
          title={
            view.loopback ? "Going back to the program on this computer" : `Going back to ${host}`
          }
        >
          <p className="auth-lead">
            If nothing happens, <a href={view.target}>continue to {host}</a>.
          </p>
          {view.loopback ? (
            <p className="field-hint">
              You can close this tab once your terminal says you're signed in.
            </p>
          ) : null}
        </Card>
      );
    }
    case "ready": {
      const info = view.info;
      return (
        <Ready
          info={info}
          redirectUri={request.redirect_uri}
          armed={armed}
          busy={busy}
          onApprove={() => void decide("approve", info)}
          onCancel={() => void decide("deny", info)}
          onSwitch={() => void signOut()}
        />
      );
    }
  }
}
