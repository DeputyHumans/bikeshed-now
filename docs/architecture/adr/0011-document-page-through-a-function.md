# 0011 — Serve the document page through a function

**Status** Accepted, amended by [0018](0018-keep-the-document-open-path-warm.md) (`minInstances`) · **Spec** §2, §17

## Context

Hosting answered every `/d/**` request with the static SPA shell, whose `<head>` says "Bikeshed" and nothing about the document. A crawler runs no JavaScript, so a pasted link unfurled as the product rather than the page. The document's title, description and image have to be in the bytes the first request returns, and Hosting cannot vary a static file by URL.

## Decision

Rewrite `/d/**` to a function, `docShell`, that serves the same shell to everyone and — only when the document is readable without an account — with its own head spliced in (SPEC §17 "Link previews"). It never authenticates: the response may be cached at a public URL, and whatever it carries is what a stranger may see.

The shell is **fetched from Hosting at runtime**, one conditional GET per request, revalidated by ETag so the usual answer is a 304. Asset names are content-hashed and `firebase deploy --only functions` ships only `functions/`, so a copy baked in at build time would strand every document page after a hosting-only deploy. The origin is `BIKESHED_PUBLIC_ORIGIN`, else the default site — **never `Host` or `X-Forwarded-Host`**, because a forged header must not choose where the shell comes from. A body is adopted only when it is evidently this app's shell; anything else serves the last adopted copy, or `503` when there is none yet.

## Consequences

- **A function now sits before every document open.** It is its own Cloud Run service, cold-started serially before `contentProxy`'s. The eager module graph every function loads includes `firebase-admin`, `markdown-it`, `turndown`, `adm-zip` and — statically, through `email/notify.ts`, contrary to what ADR 0008 says — `react` and `@react-email/components`. At the defaults (256 MiB, concurrency 80, min instances 0) the first request to a freshly deployed revision measured 1.8 s to first byte on 2026-09-21, and 0.3–0.4 s warm. `minInstances: 1` on `docShell` alone is the knob; at that number it is not set.
- **Preview channels do not preview `/d/**`.** The function fetches the live site's shell, whose asset paths are root-relative, so a document page on a channel makes the browser ask the channel host for the live build's hashed asset names — which it does not have. The page is blank.
- One more service needs `allUsers` as `roles/run.invoker`. `firebase deploy` grants it when it creates the function; under Domain Restricted Sharing the deploy fails at "set invoker", and `docs/operations/overview.md` has the repair.
- A document's shell is cached like its content: the same five-minute window, and withdrawing a version does not purge it.

## What would change this

Open latency becoming a complaint that `minInstances` does not settle. The alternative is writing the head into Hosting at publish time, which brings back the deploy coupling this avoids. Or a second route needing the same treatment, at which point one shell-serving function with a route table is the shape, not two functions each fetching the shell.
