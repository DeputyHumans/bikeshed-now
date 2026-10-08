// SPDX-License-Identifier: Apache-2.0
// The authorize request is kept, stripped and followed only back where it came from (SPEC §23)

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CAPTURE_TTL_MS,
  captureAuthorizeRequest,
  clearAuthorizeRequest,
  safeNavigate,
} from "./oauth";

const QUERY =
  "?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclient.json" +
  "&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
  "&code_challenge=abc&code_challenge_method=S256&state=s1" +
  "&resource=https%3A%2F%2Fexample.test%2Fmcp&utm_source=elsewhere";

function arriveAt(path: string) {
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  clearAuthorizeRequest();
  sessionStorage.clear();
  arriveAt("/");
});

afterEach(() => {
  clearAuthorizeRequest();
  sessionStorage.clear();
});

describe("captureAuthorizeRequest", () => {
  it("strips the query from the address and still returns the params", () => {
    arriveAt(`/connect${QUERY}`);
    const request = captureAuthorizeRequest();

    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/connect");
    expect(window.location.href).not.toContain("client_id");
    expect(request).toEqual({
      response_type: "code",
      client_id: "https://claude.ai/oauth/client.json",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "abc",
      code_challenge_method: "S256",
      state: "s1",
      resource: "https://example.test/mcp",
    });
  });

  it("keeps only the allowlisted keys", () => {
    arriveAt(`/connect${QUERY}`);
    expect(captureAuthorizeRequest()).not.toHaveProperty("utm_source");
  });

  /** StrictMode calls a state initialiser twice; the second sees no query. */
  it("returns the same request when called again", () => {
    arriveAt(`/connect${QUERY}`);
    const first = captureAuthorizeRequest();
    const second = captureAuthorizeRequest();
    expect(second).toEqual(first);
    expect(window.location.search).toBe("");
  });

  it("survives a reload of the tab, from sessionStorage", () => {
    arriveAt(`/connect${QUERY}`);
    const first = captureAuthorizeRequest();
    arriveAt("/connect");
    expect(captureAuthorizeRequest()).toEqual(first);
    expect(sessionStorage.length).toBe(1);
  });

  it("forgets a request after ten minutes", () => {
    const now = 1_000_000;
    arriveAt(`/connect${QUERY}`);
    captureAuthorizeRequest(now);
    expect(captureAuthorizeRequest(now + CAPTURE_TTL_MS - 1)).not.toBeNull();
    expect(captureAuthorizeRequest(now + CAPTURE_TTL_MS)).toBeNull();
    // And it stays gone: the expired copy is removed, not just skipped.
    expect(captureAuthorizeRequest(now)).toBeNull();
  });

  it("forgets a request once it is cleared", () => {
    arriveAt(`/connect${QUERY}`);
    captureAuthorizeRequest();
    clearAuthorizeRequest();
    expect(captureAuthorizeRequest()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("returns nothing when nothing was asked", () => {
    arriveAt("/connect");
    expect(captureAuthorizeRequest()).toBeNull();
  });

  it("replaces an older request with a newer one", () => {
    arriveAt(`/connect${QUERY}`);
    captureAuthorizeRequest();
    arriveAt("/connect?client_id=other&state=s2");
    expect(captureAuthorizeRequest()).toEqual({ client_id: "other", state: "s2" });
  });
});

describe("safeNavigate", () => {
  const web = "https://app.example.com/cb";

  it("follows the redirect_uri with a query appended", () => {
    const url = `${web}?code=c&state=s&iss=https%3A%2F%2Fexample.test`;
    expect(safeNavigate(url, web)).toBe(url);
  });

  it("follows a redirect_uri that already has a query, extended with &", () => {
    const withQuery = "https://app.example.com/cb?x=1";
    const url = `${withQuery}&code=c&state=s`;
    expect(safeNavigate(url, withQuery)).toBe(url);
    // The server appends with & here, so ? would mean something else built it.
    expect(safeNavigate(`${withQuery}?code=c`, withQuery)).toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)?code=c"],
    ["leading-space javascript:", " javascript:alert(1)?code=c"],
    ["mixed-case JavaScript:", "JavaScript:alert(1)?code=c"],
    ["tab-split java\\tscript:", "java\tscript:alert(1)?code=c"],
    ["data:", "data:text/html,hi?code=c"],
    ["vbscript:", "vbscript:x?code=c"],
    ["blob:", "blob:https://app.example.com/x?code=c"],
    ["file:", "file:///etc/passwd?code=c"],
    ["about:", "about:blank?code=c"],
  ])("refuses %s even when it is the redirect_uri itself", (_label, url) => {
    // The worst case: the request named the dangerous URL, so the prefix
    // check passes and only the protocol check stands in the way.
    const redirectUri = url.slice(0, url.indexOf("?"));
    expect(safeNavigate(url, redirectUri)).toBeNull();
  });

  it("refuses a different host", () => {
    expect(safeNavigate("https://evil.test/cb?code=c", web)).toBeNull();
  });

  it("refuses a host that merely starts the same way", () => {
    expect(safeNavigate("https://app.example.com.evil.test/cb?code=c", web)).toBeNull();
    expect(safeNavigate("https://app.example.com/cb.evil.test?code=c", web)).toBeNull();
    expect(safeNavigate("https://app.example.com/cbx?code=c", web)).toBeNull();
  });

  it("refuses a fragment where the query should be", () => {
    expect(safeNavigate(`${web}#code=c`, web)).toBeNull();
  });

  it("refuses plain http except on this computer", () => {
    expect(safeNavigate("http://app.example.com/cb?code=c", "http://app.example.com/cb")).toBeNull();
    for (const host of ["127.0.0.1:53682", "[::1]:53682", "localhost:53682"]) {
      const uri = `http://${host}/callback`;
      expect(safeNavigate(`${uri}?code=c`, uri), host).toBe(`${uri}?code=c`);
    }
  });

  it("allows an app's own scheme when that is the redirect_uri", () => {
    const cursor = "cursor://anysphere.cursor-retrieval/oauth/callback";
    expect(safeNavigate(`${cursor}?code=c&state=s`, cursor)).toBe(`${cursor}?code=c&state=s`);
  });

  it("refuses without a redirect_uri to compare against", () => {
    expect(safeNavigate(`${web}?code=c`, undefined)).toBeNull();
    expect(safeNavigate(`${web}?code=c`, "")).toBeNull();
    expect(safeNavigate(42, web)).toBeNull();
  });
});
