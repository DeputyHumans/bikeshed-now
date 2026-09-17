// SPDX-License-Identifier: Apache-2.0
// The one place a client calls an endpoint (SPEC §2).

/**
 * Eight modules post JSON to an endpoint and need the same four things: the
 * same-origin credential, a parsed error message, a typed 409, and a sentence a
 * person can act on. Nine copies of that is how the wording drifts until one
 * screen says "Forbidden" and another says "You do not have access".
 *
 * Deliberately thin. It adds no retry, no queue and no cache: a failed share
 * should surface immediately, and a retry that silently succeeds later is worse
 * than an error the person can see.
 */

/** A 409 the caller is expected to branch on rather than merely display. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function messageFrom(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    /* keep the fallback */
  }
  return fallback;
}

export interface ApiOptions {
  /** Shown for a 403. The generic wording is rarely the useful one. */
  forbidden?: string;
  fallback?: string;
}

/** POST JSON to an endpoint and return its JSON reply. */
export async function post<T>(
  path: string,
  body: unknown,
  opts: ApiOptions = {},
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });

  if (res.ok) return (await res.json()) as T;

  if (res.status === 401) {
    throw new ApiError("Your session expired — sign in again.", 401);
  }
  if (res.status === 403) {
    throw new ApiError(opts.forbidden ?? "You do not have access to do that.", 403);
  }
  if (res.status === 409) {
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ConflictError(
      typeof detail.error === "string" ? detail.error : "That conflicts with a change somebody else made.",
      detail,
    );
  }
  throw new ApiError(
    await messageFrom(res, opts.fallback ?? `That did not work (${res.status}).`),
    res.status,
  );
}
