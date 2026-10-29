// SPDX-License-Identifier: Apache-2.0
// Signed-in headless Chrome users for e2e specs: the pool, one context per user, UI actions and the isolation tripwire (SPEC §12).

/**
 * One USER is one BrowserContext (its own cookies, storage and IndexedDB —
 * Firebase Auth persists there), with one page, in a Chrome process shared by
 * at most `usersPerBrowser` users. N users take ceil(N / usersPerBrowser)
 * Chrome processes.
 *
 * Chrome is found in this order, and never downloaded:
 *   1. `E2E_CHROME`, an explicitly configured executable path;
 *   2. the matching ms-playwright cache (`chromium.executablePath()`), if installed;
 *   3. the system Chrome (`channel: "chrome"`).
 * No userDataDir is ever passed: every context is a Playwright temp profile.
 * Every Chrome is launched with `--e2e-browser-mark=<…>` on its command line
 * (browsers.mjs), naming the run and the process that launched it, so `reap`
 * can find and stop one whose run is gone; nothing without the mark is ever
 * signalled.
 *
 * MEMORY. A pool makes contexts only while the machine has room for them:
 * before its first context, 2 GB + 600 MB per context it is about to make
 * (E2E_POOL_BASE_GB, E2E_POOL_CONTEXT_MB; `many(n)` asks for n at once), then
 * 600 MB per further context, must be available — memory_pressure's free
 * share of physical memory, the stack gate's figure (load.mjs). It waits up to
 * E2E_POOL_WAIT_MS (120 s), logging to the invocation's load.jsonl, and then
 * throws E2E_INCONCLUSIVE: a case short of memory measured nothing.
 * close() reaches every browser, whatever closing a user or a context threw.
 *
 * ISOLATION TRIPWIRE. Every request of every context goes through one route.
 * On a local target a request to a loopback port that is not one of the
 * stack's, or to a real Google host, is aborted and recorded as an
 * "isolation breach", which fails the test (`assertIsolation`, called by
 * scenario()). Any other external host is aborted and recorded as external —
 * the fixtures are self-contained, so nothing legitimate goes there. WebSocket
 * URLs are checked as they open; they cannot be aborted, only recorded. On a
 * `--rtdb-proxy` stack the Database emulator's OWN port is a breach too: every
 * page reaches the database through the proxy (whose rewrite of the server's
 * handshake keeps reconnects on it), so a page on the emulator's port has
 * bypassed the proxy and its delay.
 *
 * One request to a Google host is blocked but is no breach: the Firestore
 * SDK's WebChannel network test, `GET https://www.google.com/images/cleardot.gif?zx=<random>`.
 * The SDK sends it by itself once its Listen channel has errored (on a loaded
 * stack, after a stall of 10 s or more: "Could not reach Cloud Firestore
 * backend", then "WebChannelConnection RPC 'Listen' stream … transport
 * errored"), to ask whether the network is up. The address is built into the
 * SDK, whatever the app is configured to reach, so it says nothing about where
 * the app points; it says the stack was slow. `isSdkProbe` matches exactly that
 * request and nothing near it (another path, another query, another port or
 * scheme, a method other than GET, a websocket are all still breaches). It is
 * aborted like any other, recorded in `log.sdkProbes` (verdict `sdk-probe`),
 * and scenario() notes it as an environment signal (lib/test.mjs).
 *
 * ANALYTICS, FULFILLED HERE. `fulfilAnalytics()` answers every request the
 * analytics SDK makes from this machine, so nothing is sent and each one is
 * counted: the measurement script and the collection hosts
 * (`ANALYTICS_HOSTS`), the SDK's dynamic web config and Firebase
 * Installations (`analyticsRequest` says which). Its route is registered
 * after the tripwire's, and Playwright consults the last route first, so it
 * answers these before the tripwire would abort them; everything else falls
 * through to the tripwire unchanged. The app gives Firebase no measurement id
 * of its own (VITE_FIREBASE_MEASUREMENT_ID only switches analytics on), so
 * the SDK takes the id from the web config, which is answered with a
 * measurement-id-shaped dummy (the stack's own when it was built with one):
 * without that answer it never inserts the measurement script at all. A
 * cross-origin request's preflight never reaches a route: Playwright answers
 * it itself while interception is on, and adds the CORS headers to a
 * fulfilled response, so the page reads these answers as it would the real
 * ones.
 *
 * WEBSOCKET FRAMES. Every frame any page of the context sends or receives on
 * any websocket, from the context's creation on, is kept in `log.wsFrames`:
 * `sent` and `received` hold the payloads as strings (a binary frame decoded
 * as UTF-8), each in the order Playwright reported them. A "frame" is one
 * websocket MESSAGE as DevTools reports it: the browser's own fragmentation of
 * a long message is invisible, and an empty message is not reported at all
 * (measured; selftest/browser-wsframes.test.mjs). The Realtime Database client
 * splits a message over 16,384 characters into several messages itself, the
 * first holding only their count: a long write is several frames here, and
 * its path is near the start of the second. Each direction keeps at most
 * WS_FRAMES_MAX frames and WS_FRAMES_MAX_CHARS characters, the oldest dropped
 * first; `total` counts every frame and `dropped` the ones let go, so an
 * absence oracle can show it saw them all. The database client's frames
 * include its auth frame, which carries the account's ID token: the lib never
 * writes them to evidence.
 *
 * WHAT A USER SAW ON THE NETWORK. `log.requests` gets one row per request, at
 * its RESPONSE: Playwright never emits `requestfinished` for some responses
 * whose body the page does not read (measured on a stack: the viewer's
 * `void fetch("/view")` beat), so a row written only at the finish would
 * never be written. The finish (or a failure after the
 * headers) then updates the same row: `finished`, the total `ms`, `failure`.
 * A request that fails before any response is a row with `failure` only.
 * `User.responses` keeps the live response objects, with the request's body,
 * for `findResponses` and `waitForResponse`; they are never written to
 * evidence.
 *
 * WHAT A PAGE SENT, AND IN WHAT ORDER. `capture({paths, method})` is opt-in
 * and starts empty: one row per matching request from the call on, written at
 * the REQUEST (so one that never gets a response is still a row), with the
 * request's JSON body and its `op`, then completed in place at its response,
 * its finish or its failure. `sentAt`, `respondedAt` and `doneAt` are this
 * process's monotonic clock (`performance.now()`) as Playwright's `request`,
 * `response` and `requestfinished`/`requestfailed` events arrive, which is the
 * order the browser reported them. The browser's own `timing()` is not used:
 * Playwright takes its `startTime` from the response's timing baseline but
 * measures `responseEnd` from the request's first event. Rows are
 * plain data (the Playwright request is a non-enumerable `request`), never
 * written to evidence by the lib: a /draft body is a whole document.
 *
 * A PAGE'S CHAIN OF REQUESTS ON A LOADED STACK. `waitFor` has one deadline
 * for the whole wait and never reads the rows it waits through, so an accept
 * the page sends only after a slow claim and a slow POST /draft runs it out
 * while the stack is still working, with nothing a stall judge can read.
 * `waitInTurn` waits on the sequence itself, row by row: no deadline while a
 * request of the page is in flight; every answer judged as it arrives
 * (Hosting's cut-off 504, lib/test.mjs isHostingCutoff, throws
 * E2E_STACK_CUTOFF); a request still unanswered `unansweredMs` (Hosting's
 * cut-off and 16 s) after it was sent throws E2E_STACK_CUTOFF too, the stack
 * not answering at all; and only a page that, with none of its requests in
 * flight, changes nothing for `idleMs` fails, "… within N ms", the wait
 * pageStall reads. In flight is `sent` (no answer yet): a response the page
 * never finishes reading stays `answered`, and must not hold the wait open.
 * A request sent before the wait began counts as unanswered only from the
 * wait's start: one the case held itself (delayRequests, sync.mjs
 * holdRequests) reached the stack only when it was let go, and the capture
 * cannot see the hold.
 *
 * Waiting rules, learned the hard way: never `networkidle` (Firestore keeps a
 * long-poll open for the life of the page), always `load` and then a poll for
 * the element that proves the state.
 *
 * WHAT THE READING FRAME LOADED. `watchFrameLoads(docId)` writes one row per
 * NAVIGATION REQUEST of a frame that is a direct child of the page and goes to
 * the document's own files (`parseDocumentPath`). Not per `framenavigated`:
 * Playwright fires that for a fragment change too, which loads nothing, and
 * only at a commit, so a load abandoned before it committed (a remount that
 * replaced it) would leave no trace. Such a load stays a row here, with
 * `committed: false`. A redirect chain is one row. The iframe's `sandbox` and
 * `class` are read from the frame's OWN element (never `iframe.doc-frame`,
 * which after a remount is another element) as its request starts: the
 * moment the browser takes the sandbox flags for the new document. A remount
 * is a new Frame (a new `frameIndex`); a reload or a link in place keeps the
 * frame's index.
 *
 * THE COMMENTS PANEL'S FIRST SNAPSHOT. The panel's default is decided once,
 * by the first annotation snapshot (open when a thread is unresolved,
 * app/src/viewer/useCommentsOpen.ts), unless the reader toggles first; after
 * that nothing flips it. So a single read-then-toggle races the snapshot: one
 * landing between the read and the click opens the panel and the click closes
 * it. `openComments` reads, presses only while it reads closed, waits briefly,
 * and repeats; once the snapshot or a press has decided, it converges.
 *
 * A REFUSED "Suggest edit". The selection toolbar never disables Suggest
 * edit outright: a selection it cannot take leaves it `aria-disabled`, and a
 * press says why (SPEC §22). Playwright's click waits for "enabled", which an
 * aria-disabled button never becomes, and `force` skips the hit test too, so
 * a press can land on a toast lying over the button. `pressSuggest` waits
 * until the button is the topmost element at its own centre, then makes a
 * real mouse click there.
 *
 * SIGNING IN. `signInUi` signs in at the sign-in page (`/signup`, with any
 * query such as `?next=`) and reports what POST /session answered: "ok",
 * "unverified" (the account exists, the next step is a code), "not_allowed"
 * or "session_failed" (SPEC §2, §14). Only "ok" sets the cookie and moves the
 * app on; the others leave it on the sign-in page, at a gate, so it waits for
 * the page that answer shows, not for a navigation that never comes. A
 * context already signed in to Firebase posts /session as the page loads,
 * and that answer is reported with `already: true`. `{here: true}` opens
 * nothing: it signs in on the sign-in page the APP navigated to (Fork's
 * `/signup?next=…&fork=1` intent, the viewer's "Sign in"), waiting for the
 * app to get there, so the flow stays the one a person has, with no reload.
 *
 * THE AUTOSAVE. The editor saves the draft (POST /draft) one debounce after
 * the last input event (app/src/viewer/useInlineEditor.ts, AUTOSAVE_MS), and
 * a save that was already in flight when a key went in still ends on
 * "Saved", without that key, before the next save has even begun. So the save
 * state alone races. `waitForAutosave({after})` waits for the first POST
 * /draft the browser STARTED at or after the last edit (the request's own
 * start time, on the browser's clock), then for the toolbar to say so;
 * `typeAndAutosave` takes that time from the document's own `input` events.
 *
 * THE MORE MENU. The viewer's overflow menu (app/src/components/Menu.tsx) is a
 * toggle: pressing its trigger while it is open closes it. Every method here
 * presses it only while it is closed, reads the menu in one go, as headed
 * groups, and leaves it closed. `download` takes the browser's own download
 * (a blob the app saves, or an attachment the server sends) and fails at once
 * on the error toast that says why there is none.
 *
 * A COMMENT ON A PAGE THAT HAS THREADS. The FAB's Comment creates the
 * annotation (a Firestore write) and only once the server has acknowledged
 * it selects the new thread (app/src/pages/DocViewer.tsx startComment); until
 * then the thread selected before the press is still the selected one, and
 * the new thread, already listed from the local write, is not. So "the
 * selected thread" right after the press is the OLD one whenever one was
 * selected, and a reply typed there goes to the wrong thread. `comment`
 * remembers every thread element on the page before the press (a WeakSet in
 * the window, no node, no attribute) and waits for a selected thread that is
 * not one of them. A press a loaded Firestore emulator refuses with a rules
 * "Service call error" (a rule's get() that failed: RULES_SERVICE_ERROR_RE)
 * is made again with `retryServiceError` and `reselect`, and when every
 * press is refused so the refusal carries a `stackCut` the case's judges read.
 * `pressRetryingServiceError` does the same for any other press whose
 * rules-guarded write the emulator can refuse so (a dialog's button), and
 * dismisses the refusals' toasts before each press again: error toasts never
 * go by themselves, and three of them stacked cover a dialog's footer.
 *
 * WHAT THE APP PRINTS. The toolbar's Print, More → "Print or save as PDF" on a
 * phone, and Cmd/Ctrl+P (app/src/export/pdf.ts printDoc)
 * appends a sandboxed iframe, writes the snapshot into it, and 250 ms later
 * calls that frame's print(). `capturePrint` puts a MutationObserver on the
 * app's own document first; its callback runs once the click handler has
 * returned, after the write, and replaces the new frame's `print` with a
 * recorder (again at each of the frame's `load` events), so what is recorded
 * is the document at the moment print() is called, and no dialog opens. The
 * reading frame (`iframe.doc-frame`) is never hooked. A print() called in the
 * same task as the frame's insertion is before the observer can see it, and
 * is missed; a frame the page cannot reach (a sandbox without
 * `allow-same-origin`) is recorded with its `hookError`. Every other iframe
 * added while armed counts as a print frame unless `match` (a selector, such
 * as `'[sandbox~="allow-modals"]'`) leaves it out: the owner's thumbnail
 * capture frame, added mid-print on a loaded page, then never holds the
 * capture up.
 *
 * RENDERING UNDER PRINT MEDIA. `pool.printRenderer()` is a scratch context in
 * the pool's Chrome (every request aborted, one device pixel per CSS pixel,
 * print media) that renders HTML it is given and reports computed styles and
 * the pixels painted, decoded by lib/png.mjs. "Hostile CSS cannot hide the
 * stamp" is judged there: the same render with and without the element, the
 * changed pixels of its colour in its corner. Each render settles (fonts
 * ready, two animation frames) before it reads anything from the page.
 *
 * WHAT A PAGE SHOWS, ON A STALLING STACK. `waitShown(locator, {path})` waits
 * for what the page shows; when the wait runs out and the page itself saw the
 * stack stall in it (Hosting's cut-off 504 on one of its requests, its
 * Firestore client losing the emulator), the page is loaded once more and
 * waited on again. A page that saw no stall is never loaded again, and the
 * error names the last load's wait alone, so pageStall judges that load.
 * `waitValue(read, want, {path})` is the same for a value read from the page
 * (a chip's state, a count), its evidence read from the page's current load.
 *
 * OPENING ON A LOADED STACK. `open(docId, {reloads, sessionCheck})` does the
 * same for the viewer and its frame: a load whose wait ran out while the
 * page saw the stack stall is loaded again, up to `reloads` times. Every
 * load of a signed-in page also posts the persisted user's ID token to
 * /session (app/src/auth.tsx, onIdTokenChanged → syncSession), and an
 * answer that is not JSON, Hosting's own 504 at its 60 s cut-off among
 * them, is "session_failed": the app goes signed out over a cookie that is
 * still valid ("Sign in to comment" over the frame that cookie served). With
 * `sessionCheck`, open waits for that load's own POST /session (the first
 * the page sends after the load began, matched by its request) and judges
 * it: the cut-off is loaded again while `reloads` allow, and otherwise
 * thrown as lib/test.mjs stackCutoff, the stack not answering. Any other
 * answer stands. Both are off by default: a signed-out reader sends no POST
 * /session, so the check is the caller's to ask for.
 *
 * WHAT MUST NEVER SHOW. An absence oracle ("the banner never appeared") cannot
 * poll: a poll reads the DOM between renders and misses what was there for
 * one. `watchFor(selector, text)` puts a MutationObserver on the top
 * document, which looks again after every change, in the same microtask
 * checkpoint as the change and so before the next render: anything present at
 * a render was present when it looked. One row per element from the moment
 * it matches (the selector, and the text if one is given) until it stops
 * matching or its document goes. It is an init script as well as an
 * evaluate, so a reload or a navigation is watched from the new document's
 * first script, and each sighting reaches Node through a binding as it
 * happens, so a document that navigates away cannot take its rows with it.
 * It adds no node and no attribute to any document, and never runs in a
 * child frame.
 *
 * A PHONE OR A TABLET. `pool.user({device: {width, height, touch: true}})` is
 * a touch device of that viewport: the context is made with Playwright's
 * `hasTouch` and `isMobile`, so the page matches `(pointer: coarse)`,
 * `(any-pointer: coarse)` and `(hover: none)`, has touch events
 * (`navigator.maxTouchPoints` 1), and honours its meta viewport (without
 * one it lays out 980 px wide, as a phone does), measured with Chrome 154
 * (selftest/browser-touch.test.mjs). `touch: false` is only a window of that
 * size, with a mouse. A context's device is fixed when it is made: a page
 * resized later keeps its pointer. `User.tap(point, {durationMs})` is a
 * finger: Chrome's own gesture (Input.synthesizeTapGesture), so the page sees
 * touch pointer events, touchstart and touchend, and for a short tap the
 * compatibility mouse events and click; held 1,200 ms it is a long press,
 * which selects the word under it and raises contextmenu. Chrome synthesizes
 * that gesture on ANY page, a mouse user's included, where the page's
 * coarse-pointer styles never applied: so tap() refuses a user that is not a
 * touch device. For an element, Playwright's own `locator.tap()` works on a
 * touch user.
 *
 * A SLOWER CPU. `throttleCpu(rate)` slows the user's page `rate` times, as
 * DevTools' CPU throttling does (Emulation.setCPUThrottlingRate), until the
 * restore it returns is called, so a render-scheduling race an idle machine
 * nearly always wins (two React renders committed inside one scheduler slice)
 * is lost far more often. Measured with Chrome 154
 * (selftest/browser-cpu.test.mjs): it slows the page's own renderer, the top
 * document and every frame that shares its process (a same-origin frame, and
 * so the document frame, read or edited, whose sandbox always keeps
 * allow-same-origin: app/src/viewer/frameMode.ts), and it holds through a
 * reload and a navigation, cross-site included; it does not slow a
 * frame in another process (a cross-site frame, a sandbox without
 * allow-same-origin) or another user. The page has ONE rate, the last any
 * CDP session set, and detaching a session that set one puts the page back
 * to full speed. So the lib keeps one session per page and never detaches
 * it, and calls stack: the latest throttle still in force sets the rate, and
 * each restore takes only its own away.
 *
 * A SLOW OR FAILING NETWORK, FOR ONE PATH. `delayRequests(path, {rules})`
 * holds this user's own requests to one path of the stack's origin, one rule
 * per request in the order they reach it (so many ms, or until a promise
 * settles), and then lets each go on with `route.fallback()`, so the
 * isolation tripwire still judges it: a save slower than the debounce, or two
 * saves delivered in the order a slow network can deliver them, with neither
 * failed. `failRequests(path, {status, count})` answers them here instead
 * (an HTTP error, or "abort", the browser's own network failure), so the
 * stack never sees them. Both take only requests on ONE of the stack's
 * ORIGINS (scheme, host and port): the app's, target.origin (`at:
 * "hosting"`, the default), or its Firestore's, where the page's Firestore
 * SDK sends its requests (`at: "firestore"`: target.firestoreUrl, as
 * firestore-client.mjs `firestoreOrigin` reads it). A request with the same
 * path to anywhere else is not theirs, so neither can answer, and so hide, an
 * isolation breach. Holding the SDK's Listen channel (FIRESTORE_LISTEN_PATH,
 * its POSTs) past 10 s is a backend too slow for the SDK: it logs "Could not
 * reach Cloud Firestore backend" and serves its offline cache until the held
 * requests go on (measured on two stacks: offline 9,974 and 10,001 ms after
 * the first held POST, the snapshot it waited for only after the hold). A
 * channel's body is form-encoded, so its rows' `postJson` is null, and the
 * raw body `match` reads carries the account's ID token (its Authorization
 * header, measured): never write it. Not sync.mjs
 * `holdRequests`, which holds N requests and releases them at once.
 *
 * THE SAVE STATE, ON THE PAGE'S CLOCK. `recordSaveStates()` records, in the
 * page, every change of the editor's save state (`.save-state` data-state,
 * app/src/wysiwyg/EditToolbar.tsx) and every `input` event of the document
 * frame, each time taken on the page's own clock (`performance.timeOrigin +
 * performance.now()`), so a debounce or a Done-timing oracle compares two
 * times from one clock, never a page time with this process's (which lags
 * under load). The input listener is the frame document's own, added from
 * the TOP page in the capture phase: it runs in a frame that runs no script
 * (the edit frame), and before the editor's own bubbling listener
 * (useInlineEditor.ts), so an input's time is never later than the start of
 * the debounce it caused. Each new frame document (edit mode remounts the
 * iframe) is listened to as its iframe loads. Rows reach Node as they happen,
 * so a navigation of the page loses none of them; it ends the recording.
 *
 * A PAGE ON ANOTHER SITE. A check on where a request comes from (SPEC §23's
 * site check on POST /oauth/consent) is only tested end to end by a request
 * a real browser sent from a page on another site, which the browser itself
 * labels `Sec-Fetch-Site: cross-site` and gives an `Origin` the spec did not
 * write. `openCrossSitePage(user)` puts the user's page on such an origin. On
 * a local stack it is the stack's own Hosting port under the other loopback
 * name (`localhost` for a stack on 127.0.0.1): another site, but a stack port,
 * so the tripwire allows it, and a loopback page, so Chrome's local-network
 * rules let it reach the stack. Elsewhere it is a reserved `.example` name the
 * page's own route answers, so nothing is fetched from anywhere. A page a
 * route answered is not on loopback as far as Chrome's local-network rules
 * go: Chrome refuses its requests to 127.0.0.1 before sending them
 * ("Permission was denied for this request to access the `loopback` address
 * space", measured with Chrome 154). So on a local stack `via: "route"` runs
 * the production path, but cannot test the stack from there.
 *
 * WHAT A PAGE CREATED. Every document and folder a user's pages create on
 * the target is the run's, whether or not the case expected it (a drop that
 * uploads two files where it meant one): the pool ledgers each one itself,
 * from the 200 answer to the request that made it (`pageCreation` says
 * which: POST /publish without `update`, POST /folder, POST /fork with
 * `op: "create"`), through seed.mjs `ledgerDoc` / `ledgerFolder`, with
 * `via` "upload-ui", "folder-ui" or "fork-ui", the user's name as `actor`
 * and the email it signed in with as `ownerEmail`. Each is a row in
 * `log.created`. The answer's body is read after the response event, so a
 * row lands a moment after the page has it: `settleCreated()` waits for every
 * creation seen so far. A spec that must act on production on what it just
 * made still ledgers it itself the moment it knows the id (ledgerDoc,
 * ledgerFolder); twice is harmless.
 *
 * DROPPED FILES, DIALOGS, TOASTS. `dropFiles(selector, files)` drops files
 * as the browser builds a drop from the desktop: a DataTransfer holding real
 * File objects, dispatched as dragenter, dragover and drop on the element,
 * and says per event whether the page claimed it (preventDefault), without
 * which the browser would navigate to the file. `answerDialog(action)` runs
 * an action and answers the window.alert, confirm or prompt it raises.
 * `dismissToasts()` presses Dismiss on every toast that has one: error toasts
 * never go by themselves, and the stack lies over a dialog's footer.
 *
 * ONE PERSON IN TWO TABS. `user.newTab({name})` opens another page in the
 * user's own context, so the same cookies, storage and signed-in account,
 * already under the context's instrumentation (the tripwire, the toast
 * observer and every log covered each page of the context before). The tab
 * is a User of its own: its own `name`, `page`, `inEdit`, `closed` and CDP
 * session. `log`, `responses`, `responseCount`, `email`, `creating` and
 * `analyticsSeen` are the context's, read and written through to the user
 * the context was made for (one array each, every tab's rows in it). What a
 * User WAITS ON is its own pages': `findResponses`, `waitForResponse`
 * (so `waitForAutosave` and everything built on them), `capture`,
 * `delayRequests`, `failRequests`, `waitForToast` and `toastsSince` take
 * only requests and toasts of a page the User owns (`ownsPage(page)`): a
 * tab, its own page; the user the context was made for, every page no tab
 * of it claims (its own, a popup, a page opened with context.newPage()).
 * A user with no tab owns every page, exactly as before. Each response
 * entry, capture row and toast names its page in a non-enumerable `page`
 * (null when the request had none), so nothing serialises it. A tab's
 * close() closes its page alone; the user's closes the context and every
 * tab with it. A closed tab keeps its page: what that page still answers is
 * never the user's.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";
import {
  DOC_FRAME,
  docFrame,
  elementPoint,
  focusState,
  framePointToPage,
  frameGeometry,
  insideFrame,
  placeCaret,
  rangeRects,
  selectionBetween,
  selectionText,
  setSelection,
  setSelectionBetween,
} from "./frame.mjs";
import { colourPixels, pngPixels } from "./png.mjs";
import { firestoreOrigin } from "./firestore-client.mjs";
import { observeFirestoreContext, preserveFirestoreResponses } from "./firestore-channels.mjs";
import { dummyMeasurementId, isMeasurementIdShape } from "./options.mjs";
import { ledgerDoc, ledgerFolder } from "./seed.mjs";
import { browserArgs } from "./browsers.mjs";
import { GIB, memoryThresholds, poolNeedBytes, sampleMemory, waitForMemory } from "./load.mjs";

/** E2E_POOL_WAIT_MS: how long a pool waits for memory before its case ends INCONCLUSIVE. */
export function poolWaitMs(env = process.env) {
  const raw = env.E2E_POOL_WAIT_MS;
  if (raw === undefined || raw === "") return 120_000;
  if (!/^\d+$/.test(String(raw))) throw new Error(`E2E_POOL_WAIT_MS wants milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

export const CHROME_ARGS = Object.freeze([
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  ...(platform() === "darwin" ? ["--use-mock-keychain"] : []),
]);

export const CONTEXT_OPTIONS = Object.freeze({
  viewport: { width: 1280, height: 800 },
  reducedMotion: "reduce",
  serviceWorkers: "block",
});

/** Real Google and Firebase hosts. On a local target, any of these is a breach (but for the SDK's network test, isSdkProbe). */
export const GOOGLE_SUFFIXES = Object.freeze([
  "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "googletagmanager.com",
  "google-analytics.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "firebaseio.com", "firebasedatabase.app", "firebaseapp.com", "firebasestorage.app", "web.app",
  "appspot.com", "cloudfunctions.net", "run.app", "gvt1.com", "gvt2.com", "ggpht.com", "withgoogle.com",
]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
const NO_NETWORK = new Set(["data:", "blob:", "about:", "javascript:", "chrome-error:", "chrome:", "devtools:"]);

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How far before a load's wait waitShown reads the page's evidence: pageStall's own margin (lib/test.mjs), so a stall already under way as the wait began counts. */
const WAIT_SHOWN_MARGIN_MS = 10_000;
/** The least time User.waitValue gives one read, even the one made as its wait runs out. */
const WAIT_VALUE_READ_MIN_MS = 1_000;

/** `fn()` raced against `deadline` (a now() time): {done: true, value, error} once it settles, else {done: false}; a late outcome is dropped. */
async function settleBy(fn, deadline) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, deadline - now()));
  });
  const run = Promise.resolve()
    .then(fn)
    .then(
      (value) => ({ done: true, value, error: null }),
      (error) => ({ done: true, value: undefined, error: error ?? new Error("the read threw without an error") }),
    );
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** When `page`'s current document began loading (its performance.timeOrigin, the same system clock as now()), or null when that is not read within 5 s. */
async function documentBegan(page) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), 5_000);
  });
  try {
    const t = await Promise.race([page.evaluate(() => performance.timeOrigin).catch(() => null), late]);
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
  } finally {
    clearTimeout(timer);
  }
}

/** A value as an error message shows it: showValue, at most 200 characters, never a throw (a BigInt, a cycle). */
function clipValue(v) {
  let s;
  try {
    s = showValue(v);
  } catch {
    s = String(v);
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * The Firestore SDK's WebChannel network test (see the header): the one
 * request to a Google host the tripwire blocks without calling it a breach.
 * `zx` is the SDK's cache buster, two base-36 numbers run together (1.0.1 of
 * @firebase/webchannel-wrapper: each below 2^31, so 2–12 characters).
 */
export const SDK_PROBE = Object.freeze({ protocol: "https:", host: "www.google.com", path: "/images/cleardot.gif", param: "zx" });
const SDK_PROBE_ZX = /^[0-9a-z]{2,12}$/;

/**
 * Is this request exactly the SDK's network test: a GET of
 * `https://www.google.com/images/cleardot.gif?zx=<base 36>` on the default
 * port, with no other query, no fragment and no credentials in the URL?
 * `method` is the request's (GET when not given). Everything else is false.
 */
export function isSdkProbe(rawUrl, { method = "GET" } = {}) {
  if (String(method).toUpperCase() !== "GET") return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== SDK_PROBE.protocol || url.hostname !== SDK_PROBE.host || url.port !== "") return false;
  if (url.username !== "" || url.password !== "" || url.pathname !== SDK_PROBE.path || url.hash !== "") return false;
  const params = [...url.searchParams];
  if (params.length !== 1 || params[0][0] !== SDK_PROBE.param || !SDK_PROBE_ZX.test(params[0][1])) return false;
  return url.search === `?${SDK_PROBE.param}=${params[0][1]}`;
}

/** Is `host` a real Google/Firebase host? */
export function isGoogleHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return GOOGLE_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * The hosts gtag loads from and reports to, with their subdomains: the
 * measurement script (googletagmanager.com) and the collection endpoints.
 */
export const ANALYTICS_HOSTS = Object.freeze(["googletagmanager.com", "google-analytics.com", "analytics.google.com", "doubleclick.net"]);
/** The SDK's dynamic web config (@firebase/analytics DYNAMIC_CONFIG_URL) and Firebase Installations (INSTALLATIONS_API_URL). */
const WEB_CONFIG_HOST = "firebase.googleapis.com";
const WEB_CONFIG_PATH = /^\/v1alpha\/projects\/-\/apps\/([^/]+)\/webConfig$/;
const INSTALLATIONS_HOST = "firebaseinstallations.googleapis.com";
const INSTALLATIONS_PATH = /^\/v1\/projects\/([^/]+)\/installations(?:\/([^/]+)(\/authTokens:generate)?)?$/;
/**
 * Where the app keeps a visitor's answer to its analytics consent banner, in
 * localStorage (app/src/consent.ts KEY), and the two answers it reads: any
 * other value, or none, is "unset", and wherever analytics is configured the
 * banner shows (app/src/components/CookieConsent.tsx).
 */
export const CONSENT_KEY = "bshd-consent";
const CONSENT_ANSWERS = Object.freeze(["denied", "granted"]);

/** `consent` as user() takes it: "denied", "granted", or null (undefined too) for unanswered; anything else throws, before anything is made. */
function checkConsent(consent, who) {
  if (consent === null || consent === undefined) return null;
  if (CONSENT_ANSWERS.includes(consent)) return consent;
  throw new TypeError(`${who}: consent is "denied", "granted" or null (unanswered), got ${JSON.stringify(consent) ?? String(consent)}`);
}

/** The storage a visitor who already answered `consent` brings: Playwright's storageState, CONSENT_KEY on `origin` alone. */
function consentStorage(origin, consent) {
  return { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: CONSENT_KEY, value: consent }] }] };
}

/** The device every user is unless user() is given one: CONTEXT_OPTIONS's window, with a mouse. */
const DESKTOP_DEVICE = Object.freeze({ width: CONTEXT_OPTIONS.viewport.width, height: CONTEXT_OPTIONS.viewport.height, touch: false });
const DEVICE_KEYS = Object.freeze(["width", "height", "touch"]);

/**
 * `device` as user() takes it: null (undefined too) for the desktop, or
 * {width, height, touch}, whole CSS px of 1 or more and touch true or false
 * (false when left out). Anything else, a key it does not take included (a
 * misspelt `touch` must not quietly make a mouse device), throws, before
 * anything is made. Returns the device, frozen. Exported so a caller that
 * makes other things before the user (live.mjs addMember casts and grants
 * first) can refuse a bad device before any of them; `who` starts the
 * TypeError's message.
 */
export function checkDevice(device, who) {
  if (device === null || device === undefined) return DESKTOP_DEVICE;
  if (typeof device !== "object" || Array.isArray(device)) throw new TypeError(`${who}: device is {width, height, touch} or null (the desktop), got ${showValue(device)}`);
  const extra = Object.keys(device).filter((k) => !DEVICE_KEYS.includes(k));
  if (extra.length) throw new TypeError(`${who}: device takes width, height and touch, not ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  const { width, height, touch = false } = device;
  for (const [k, v] of [["width", width], ["height", height]]) {
    if (!Number.isInteger(v) || v < 1) throw new TypeError(`${who}: device.${k} is a whole number of CSS px, 1 or more, got ${showValue(v)}`);
  }
  if (typeof touch !== "boolean") throw new TypeError(`${who}: device.touch is true (a phone or tablet) or false (a mouse), got ${showValue(touch)}`);
  return Object.freeze({ width, height, touch });
}

/** The context options a device adds to CONTEXT_OPTIONS: none for the desktop, else its viewport, and for touch Playwright's hasTouch and isMobile. */
function deviceOptions(device) {
  if (device === DESKTOP_DEVICE) return {};
  return { viewport: { width: device.width, height: device.height }, ...(device.touch ? { hasTouch: true, isMobile: true } : {}) };
}

/** What a fulfilled measurement script holds: nothing that runs, so nothing is ever collected. */
export const ANALYTICS_SCRIPT_STUB = "/* e2e: the measurement script, fulfilled locally by the harness and never sent */\n";
const FULFILLED_TOKEN = "e2e-fulfilled-locally";
const FULFILLED_TTL = "604800s";

/**
 * Which analytics request a URL is, or null: `{kind: "gtag"}` for
 * googletagmanager.com, `{kind: "collect"}` for google-analytics.com,
 * analytics.google.com and doubleclick.net (any subdomain, http or https, any
 * path); `{kind: "web-config", appId}` for exactly `GET
 * https://firebase.googleapis.com/v1alpha/projects/-/apps/<appId>/webConfig`;
 * `{kind: "installations", projectId, fid, op}` for exactly
 * `https://firebaseinstallations.googleapis.com/v1/projects/<project>/installations[/<fid>[/authTokens:generate]]`
 * (`op`: "create" for a POST of the collection, "token" for a POST of
 * authTokens:generate, "delete" for a DELETE of one installation, else
 * null). Any other path, port or method at those two Google API hosts, a URL
 * with credentials, and a websocket are null: the tripwire judges them.
 */
export function analyticsRequest(rawUrl, { method = "GET" } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const m = String(method).toUpperCase();
  const under = (s) => host === s || host.endsWith(`.${s}`);
  if (under(ANALYTICS_HOSTS[0])) return { kind: "gtag" };
  if (ANALYTICS_HOSTS.slice(1).some(under)) return { kind: "collect" };
  if (url.protocol !== "https:" || url.port !== "") return null;
  if (host === WEB_CONFIG_HOST && m === "GET") {
    const w = WEB_CONFIG_PATH.exec(url.pathname);
    if (!w) return null;
    try {
      return { kind: "web-config", appId: decodeURIComponent(w[1]) };
    } catch {
      return null;
    }
  }
  if (host === INSTALLATIONS_HOST) {
    const i = INSTALLATIONS_PATH.exec(url.pathname);
    if (!i) return null;
    const [, projectId, fid = null, token = null] = i;
    const op = m === "POST" && !fid ? "create" : m === "POST" && token ? "token" : m === "DELETE" && fid && !token ? "delete" : null;
    return { kind: "installations", projectId, fid, op };
  }
  return null;
}

/** The answer fulfilAnalytics gives one analytics request: {status, contentType, body}. */
function analyticsAnswer(hit, { measurementId, postJson }) {
  const json = (status, value) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) });
  if (hit.kind === "gtag") return { status: 200, contentType: "application/javascript; charset=utf-8", body: ANALYTICS_SCRIPT_STUB };
  if (hit.kind === "collect") return { status: 204, contentType: null, body: "" };
  // The fields @firebase/analytics reads from its web config: the id it then loads gtag for.
  if (hit.kind === "web-config") return json(200, { appId: hit.appId, measurementId });
  if (hit.op === "create") {
    const asked = typeof postJson?.fid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(postJson.fid) ? postJson.fid : null;
    const fid = asked ?? "e2eFulfilledFid0000000";
    return json(200, { name: `projects/${hit.projectId}/installations/${fid}`, fid, refreshToken: FULFILLED_TOKEN, authToken: { token: FULFILLED_TOKEN, expiresIn: FULFILLED_TTL } });
  }
  if (hit.op === "token") return json(200, { token: FULFILLED_TOKEN, expiresIn: FULFILLED_TTL });
  if (hit.op === "delete") return json(200, {});
  return json(404, { error: { code: 404, message: "e2e: not an installations call the harness answers", status: "NOT_FOUND" } });
}

/**
 * The tripwire's verdict on one URL: `allow`, `breach` (fails the test),
 * `external` (blocked, recorded, not a failure) or, on a local target only,
 * `sdk-probe` (the SDK's network test, isSdkProbe: blocked, recorded, not a
 * failure). `method` is the request's, GET when not given.
 */
export function classifyUrl(rawUrl, target, { method = "GET" } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { verdict: "allow", reason: "not a URL" };
  }
  if (NO_NETWORK.has(url.protocol)) return { verdict: "allow", reason: "no network" };
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
  const loopback = LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (target.kind === "local") {
    if (loopback) {
      const ports = new Set(Object.values(target.stack?.ports ?? {}).map(Number));
      // On a --rtdb-proxy stack every browser reaches the database through the
      // proxy; the emulator's own port means a page bypassed it (and its delay).
      const proxied = target.options?.rtdbProxy === true || target.capabilities?.has?.("rtdb-proxy") === true;
      if (proxied && port === Number(target.stack?.ports?.database)) {
        return { verdict: "breach", reason: `the Database emulator's own port ${port} on a --rtdb-proxy stack: the page bypassed the RTDB proxy (port ${target.stack?.ports?.rtdbProxy})` };
      }
      return ports.has(port)
        ? { verdict: "allow", reason: "stack port" }
        : { verdict: "breach", reason: `loopback port ${port} is not one of stack ${target.runId}'s` };
    }
    if (isSdkProbe(url.href, { method })) return { verdict: "sdk-probe", reason: "the Firestore SDK's network test, sent after its Listen channel errored (a slow stack): blocked, not a breach" };
    if (isGoogleHost(host)) return { verdict: "breach", reason: `real Google host ${host} from a local target` };
    return { verdict: "external", reason: `external host ${host}` };
  }
  // A production target: its own origin and the Google APIs the SDK needs, never analytics.
  const origin = new URL(target.origin);
  if (host === origin.hostname) return { verdict: "allow", reason: "origin" };
  if (loopback) return { verdict: "breach", reason: `loopback ${host}:${port} from a prod target` };
  if (/(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)doubleclick\.net$|^analytics\.google\.com$/.test(host)) {
    return { verdict: "breach", reason: `analytics host ${host}` };
  }
  if (isGoogleHost(host)) return { verdict: "allow", reason: "Google API" };
  return { verdict: "external", reason: `external host ${host}` };
}

/**
 * Is `pathname` one of a document's own files? The reading frame loads
 * `/content/[~<link key>/][!run/]<docId>/<versionId>/<file>` and the draft
 * `/draft/<docId>/<file>` (app/src/viewer/frameMode.ts `frameSrc`; `!run` is
 * the run variant an unsandboxed frame asks for, ADR 0021). Returns
 * `{kind: "content" | "draft", docId, versionId, keyed, run}` (versionId null
 * for a draft; keyed when the path carries a link key; run when it asks for the
 * document's script to run), or null.
 */
export function parseDocumentPath(pathname) {
  const segs = String(pathname ?? "").split("/");
  if (segs[0] !== "" || segs.length < 4) return null;
  const dec = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  if (segs[1] === "draft") {
    const docId = dec(segs[2]);
    return docId ? { kind: "draft", docId, versionId: null, keyed: false, run: false } : null;
  }
  if (segs[1] !== "content") return null;
  const keyed = segs[2].startsWith("~");
  if (keyed && segs[2].length < 2) return null;
  const afterKey = keyed ? 3 : 2;
  const run = segs[afterKey] === "!run";
  const at = run ? afterKey + 1 : afterKey;
  if (segs.length < at + 3) return null;
  const docId = dec(segs[at]);
  const versionId = dec(segs[at + 1]);
  return docId && versionId ? { kind: "content", docId, versionId, keyed, run } : null;
}

/**
 * Before a click: what the topmost element at the page point is (it must be
 * the document iframe, or the click lands on the viewer's own UI) and, inside
 * the frame, whether the element at the frame point is the target or inside
 * it. `selector` null checks the page side only.
 */
async function hitAt(page, frame, pagePoint, inner, selector) {
  const top = await page.evaluate(
    ({ x, y, sel }) => {
      const el = document.elementFromPoint(x, y);
      const d = (n) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : ""}` : "nothing");
      return { isFrame: el != null && el === document.querySelector(sel), desc: d(el) };
    },
    { x: pagePoint.x, y: pagePoint.y, sel: DOC_FRAME },
  );
  const inside = await frame.evaluate(
    ({ x, y, selector }) => {
      const el = document.elementFromPoint(x, y);
      const d = (n) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : ""}` : "nothing");
      const want = selector ? document.querySelector(selector) : null;
      return { onTarget: selector ? Boolean(el && want && (el === want || want.contains(el))) : el != null, desc: d(el) };
    },
    { x: inner.x, y: inner.y, selector },
  );
  return { ok: top.isFrame && inside.onTarget, page: top.isFrame ? "frame" : top.desc, frame: inside.desc };
}

/** Selection only: use the SDK-matched build when installed; never download during a test. */
export function chromeCandidates({ configured = process.env.E2E_CHROME, cached = chromium.executablePath(), exists = existsSync } = {}) {
  return [
    ...(configured ? [{ via: "E2E_CHROME", executablePath: configured }] : []),
    ...(cached && exists(cached) ? [{ via: "ms-playwright-cache", executablePath: cached }] : []),
    { via: "channel:chrome", channel: "chrome" },
  ];
}

/** Launch Chrome by the documented fallback order. */
export async function launchChrome({ headless = true, args = [] } = {}) {
  // The mark that lets reap find this Chrome once its run is gone (browsers.mjs).
  const common = { headless, args: [...CHROME_ARGS, ...args, ...browserArgs()] };
  const attempts = [];
  for (const { via, ...selection } of chromeCandidates()) {
    try {
      const browser = await chromium.launch({ ...common, ...selection });
      return { browser, via, version: browser.version() };
    } catch (err) {
      attempts.push(`${via}: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error(`no Chrome could be launched:\n  ${attempts.join("\n  ")}`);
}

/** Init script: records every toast the app shows, in the top frame only. */
function toastObserver() {
  if (window.top !== window) return;
  const seen = new WeakSet();
  const report = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const span = Array.from(el.children).find((c) => c.tagName === "SPAN" && !c.classList.contains("spinner"));
    const kind = el.classList.contains("toast-error") ? "error" : el.classList.contains("toast-busy") ? "busy" : "info";
    try {
      window.__e2eToast({ t: Date.now(), kind, role: el.getAttribute("role"), text: (span?.textContent ?? el.textContent ?? "").trim() });
    } catch {
      /* the binding is gone during a navigation; the next toast is still caught */
    }
  };
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches(".toast-stack .toast, .toast-stack > .toast")) report(node);
    for (const t of node.querySelectorAll?.(".toast") ?? []) if (t.closest(".toast-stack")) report(t);
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) for (const n of m.addedNodes) visit(n);
  }).observe(document, { childList: true, subtree: true });
}

/**
 * Init script and installer for User.watchFor, in the top frame only (see the
 * header). `o` is {key, binding, selector, text, re, via}: the window property
 * that holds this document's state, the binding sightings go to, what to
 * match, and how it was installed ("load": the init script, "call": the
 * evaluate at the call). One row per element from when it matches to when it
 * stops; the state also keeps every row, so a binding call lost to a
 * navigation is only lost for documents already gone.
 */
function domWatcher(o) {
  if (window.top !== window || window[o.key]) return;
  const re = o.re ? new RegExp(o.re.source, o.re.flags.replace(/[gy]/g, "")) : null;
  const textOk = (el) => {
    if (re === null && o.text === null) return true;
    const t = el.textContent ?? "";
    return re ? re.test(t) : t.includes(o.text);
  };
  const shown = (el) => {
    try {
      return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
    } catch {
      return null;
    }
  };
  const send = (msg) => {
    try {
      return window[o.binding](msg);
    } catch {
      return null; // the binding is gone during a navigation; the rows below still hold it
    }
  };
  const s = { doc: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, t: Date.now(), path: location.pathname, rows: [], live: new Map(), scans: 0, stopped: false, observer: null };
  s.scan = () => {
    if (s.stopped) return;
    s.scans += 1;
    const t = Date.now();
    const now = new Set();
    for (const el of document.querySelectorAll(o.selector)) if (textOk(el)) now.add(el);
    for (const el of now) {
      if (s.live.has(el)) continue;
      const row = { id: s.rows.length + 1, t, goneAt: null, path: location.pathname, text: (el.textContent ?? "").trim().slice(0, 500), visible: shown(el) };
      s.rows.push(row);
      s.live.set(el, row);
      send({ doc: s.doc, type: "seen", row: { ...row } });
    }
    for (const [el, row] of s.live) {
      if (now.has(el)) continue;
      s.live.delete(el);
      row.goneAt = t;
      send({ doc: s.doc, type: "gone", id: row.id, t });
    }
  };
  s.snapshot = () => {
    s.scan();
    return { doc: s.doc, t: s.t, path: s.path, scans: s.scans, rows: s.rows.map((r) => ({ ...r })) };
  };
  s.stop = () => {
    const snap = s.snapshot();
    s.stopped = true;
    s.observer?.disconnect();
    return snap;
  };
  window[o.key] = s;
  // Node answers "stop" to a document that starts after the watch was stopped.
  Promise.resolve(send({ doc: s.doc, type: "install", t: s.t, path: s.path, via: o.via }))
    .then((answer) => {
      if (answer === "stop") s.stop();
    })
    .catch(() => {});
  s.observer = new MutationObserver(() => s.scan());
  s.observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  s.scan();
}

/** How many rows `log.requests` and `User.responses` each keep (the oldest go first). */
const NETWORK_LOG_MAX = 5000;

/** At most this many websocket frames per direction in `log.wsFrames`, the oldest dropped first. */
export const WS_FRAMES_MAX = 5000;
/** At most this many characters of websocket frames per direction in `log.wsFrames` (the newest frame is always kept). */
export const WS_FRAMES_MAX_CHARS = 8 * 1024 * 1024;

/**
 * A user's websocket frame log: `{sent, received, total: {sent, received},
 * dropped: {sent, received}}`, plus a non-enumerable `push(direction,
 * payload)` the instrumentation calls. Plain data otherwise.
 */
function wsFrameLog() {
  const log = { sent: [], received: [], total: { sent: 0, received: 0 }, dropped: { sent: 0, received: 0 } };
  const chars = { sent: 0, received: 0 };
  Object.defineProperty(log, "push", {
    enumerable: false,
    value: (dir, payload) => {
      const list = log[dir];
      const text = typeof payload === "string" ? payload : Buffer.from(payload ?? "").toString("utf8");
      list.push(text);
      chars[dir] += text.length;
      log.total[dir] += 1;
      let drop = 0;
      while (list.length - drop > WS_FRAMES_MAX || (chars[dir] > WS_FRAMES_MAX_CHARS && list.length - drop > 1)) {
        chars[dir] -= list[drop].length;
        drop += 1;
      }
      if (drop > 0) {
        list.splice(0, drop);
        log.dropped[dir] += drop;
      }
    },
  });
  return log;
}

/**
 * What POST /session answers, by its body's `status` (functions/src/index.ts, SPEC §2): signInUi's expectStatus values.
 * `moving` is the fifth outcome and is not one of them: it answers only a body carrying Google's ID token after a
 * Google popup (SPEC §14), which the password form signInUi drives never sends.
 */
const SESSION_OUTCOMES = Object.freeze(["ok", "unverified", "not_allowed", "session_failed"]);
const SESSION_POST = Object.freeze({ method: "POST", path: "/session" });
/** The sign-in page's pathname, as the router matches it (lowercased). */
const SIGN_IN_PATH = "/signup";
/**
 * signInUi's default `timeout`, for each of its waits: past the Hosting
 * emulator's 504 for a function that has not answered within 60 s (measured
 * 60,005–60,010 ms on POST /session under load) and the page showing it.
 * A shorter wait runs out with POST /session still open, a failure no judge
 * can read; this one ends in that 504, which the refusal carries as
 * `response` (lib/test.mjs stackDidNotAnswer).
 */
const SIGN_IN_TIMEOUT_MS = 75_000;

/** signInUi's expectStatus as a Set of outcomes, or null for "whatever it answers". */
function sessionExpectation(expectStatus) {
  if (expectStatus === null) return null;
  const list = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
  if (list.length === 0 || !list.every((s) => SESSION_OUTCOMES.includes(s))) {
    throw new Error(`signInUi: expectStatus is ${SESSION_OUTCOMES.map((s) => JSON.stringify(s)).join(", ")}, a list of them, or null, got ${JSON.stringify(expectStatus)}`);
  }
  return new Set(list);
}

/** The sign-in page's pathname, lowercased, when `path` is it on `origin` (with any query or fragment); anything else throws. */
function signInPathname(origin, path) {
  let u = null;
  if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) {
    try {
      u = new URL(path, origin);
    } catch {
      u = null;
    }
  }
  // The router matches paths case-insensitively, so /SIGNUP is the same page.
  if (!u || u.origin !== new URL(origin).origin || u.pathname.toLowerCase() !== "/signup") {
    throw new Error(`signInUi: path is the sign-in page on this origin, /signup[?…][#…], got ${JSON.stringify(path)}`);
  }
  return u.pathname.toLowerCase();
}

/**
 * In the page, in one read (app/src/pages/SignUp.tsx): where sign-in stands.
 *   {state: "left", path}                  the app moved off the sign-in page
 *   {state: "form", error}                 signed out: the password form shows; `error` is the card's alert text, or null
 *   {state: "unverified", gate}            not admitted, step 3 ("needs_verification") or 2 ("needs_email") current
 *   {state: "not_allowed", gate}           not admitted, step 1 current, no form, a notice
 *   null                                   anything else, such as the "Signing in" spinner
 */
function signInPageState(signPath) {
  if (location.pathname.toLowerCase() !== signPath) return { state: "left", path: `${location.pathname}${location.search}${location.hash}` };
  const shown = (el) => Boolean(el) && el.getClientRects().length > 0;
  const card = document.querySelector(".auth-card");
  if (shown(document.querySelector("#auth-password"))) {
    const alerts = card ? Array.from(card.querySelectorAll('[role="alert"]')).filter(shown).map((el) => (el.textContent ?? "").trim()).filter(Boolean) : [];
    return { state: "form", error: [...new Set(alerts)].join(" | ") || null };
  }
  if (!card) return null;
  const step = Array.from(card.querySelectorAll(".auth-step")).findIndex((el) => el.getAttribute("aria-current") === "step") + 1;
  if (step === 3) return { state: "unverified", gate: "needs_verification" };
  if (step === 2) return { state: "unverified", gate: "needs_email" };
  if (step === 1 && card.querySelector('.auth-notice[role="status"]')) return { state: "not_allowed", gate: "not_allowed" };
  return null;
}

/** The outcome a sign-in page state shows, and the app's gate for it. */
const SIGN_IN_OUTCOME = Object.freeze({ left: "ok", unverified: "unverified", not_allowed: "not_allowed", form: "session_failed" });
const signInGate = (s) => (s.state === "left" ? "ready" : s.state === "form" ? "signed_out" : s.gate);

/** The page state an answered outcome settles on. */
const SETTLES_ON = Object.freeze({ ok: "left", unverified: "unverified", not_allowed: "not_allowed" });

/**
 * signInUi's `next`: what the app lands on once signed in, `${pathname}${search}`
 * as the URL parser normalises it, and its pathname alone (what a message may
 * show: the query may hold a link key). Only a path the app honours
 * (app/src/next.ts safeNext: "/…" on this origin, not "//…", no backslash, no
 * control character) is taken; the app sends anything else to "/", so it throws.
 */
function signInNext(origin, next) {
  const bad = () => new Error(`signInUi: next is a path on this origin that the app honours (app/src/next.ts safeNext): "/…", not "//…", with no backslash or control character, got ${showValue(next)}`);
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) throw bad();
  let u;
  try {
    u = new URL(next, origin);
  } catch {
    throw bad();
  }
  if (u.origin !== new URL(origin).origin) throw bad();
  return { want: `${u.pathname}${u.search}`, pathname: u.pathname };
}

/** A page URL's `${pathname}${search}`, or null when it is not a URL. */
function pathAndSearch(raw) {
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** A page URL's pathname alone (never its query, which may hold a link key). */
function pathnameOf(raw) {
  try {
    return new URL(raw).pathname;
  } catch {
    return String(raw).split(/[?#]/)[0];
  }
}

/**
 * An error refusing the answer `entry` (a User response entry) carries it as
 * `response`: a plain {method, path, status, ms}, never the live Playwright
 * objects. lib/test.mjs's stackDidNotAnswer reads it, so Hosting's cut-off
 * 504 refused here is the stack not answering, and a quicker one is judged.
 */
function refusing(message, entry) {
  const err = new Error(message);
  if (entry) err.response = { method: entry.method, path: entry.path, status: entry.status, ms: entry.ms };
  return err;
}

/** A response's JSON body, or null when it cannot be read (a navigation can take it away). */
async function responseJson(res) {
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * A response predicate: a function of the entry (one that throws is a
 * non-match), an exact path, a RegExp over the path, or
 * {method, path (string or RegExp), status (a number or a list)}.
 */
function responseMatcher(pred) {
  if (typeof pred === "function") {
    return (r) => {
      try {
        return Boolean(pred(r));
      } catch {
        return false;
      }
    };
  }
  if (typeof pred === "string") return (r) => r.path === pred;
  if (pred instanceof RegExp) return (r) => pred.test(r.path ?? "");
  if (pred && typeof pred === "object") {
    const method = pred.method == null ? null : String(pred.method).toUpperCase();
    const { path, status } = pred;
    return (r) =>
      (method === null || r.method === method) &&
      (path == null || (path instanceof RegExp ? path.test(r.path ?? "") : r.path === path)) &&
      (status == null || (Array.isArray(status) ? status.includes(r.status) : r.status === status));
  }
  throw new Error(`response predicate: want a function, a path, a RegExp or {method, path, status}, got ${pred === null ? "null" : typeof pred}`);
}

/** One entry of User.responses: the response as it arrived, with the request's body read on demand. */
function responseEntry(seq, res, req, t, at) {
  const url = req.url();
  let path = null;
  try {
    path = new URL(url).pathname;
  } catch {}
  let headers = {};
  try {
    headers = res.headers();
  } catch {}
  return {
    seq,
    t,
    at,
    ms: at - t,
    method: req.method(),
    url,
    path,
    type: req.resourceType(),
    status: res.status(),
    headers,
    get query() {
      return new URL(url).searchParams;
    },
    get requestHeaders() {
      return req.headers();
    },
    get postData() {
      return req.postData();
    },
    get postBuffer() {
      return req.postDataBuffer();
    },
    get postJson() {
      const s = req.postData();
      if (s == null) return null;
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    },
    response: res,
    request: req,
  };
}

/** A value as an error message shows it: a RegExp as its source, a list item by item. */
const showValue = (v) => (v instanceof RegExp ? String(v) : Array.isArray(v) ? `[${v.map(showValue).join(", ")}]` : (JSON.stringify(v) ?? String(v)));

/** Text parsed as JSON, or null when it is not JSON (or there is none). */
function jsonOrNull(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * User.capture's filter over a request: `paths` (null for every path, an
 * exact path, a RegExp over the path, or a non-empty list of them) and
 * `method` (a method, a non-empty list of them, or null for any). Anything
 * else throws.
 */
function captureFilter(name, paths, method) {
  const list = paths == null ? null : Array.isArray(paths) ? paths : [paths];
  if (list && (list.length === 0 || !list.every((p) => (typeof p === "string" && p.startsWith("/")) || p instanceof RegExp))) {
    throw new Error(`${name}: capture paths is a path ("/…"), a RegExp, a list of them, or null, got ${showValue(paths)}`);
  }
  const methods = method == null ? null : Array.isArray(method) ? method : [method];
  if (methods && (methods.length === 0 || !methods.every((m) => typeof m === "string" && /^[A-Za-z]+$/.test(m)))) {
    throw new Error(`${name}: capture method is a method, a list of them, or null, got ${showValue(method)}`);
  }
  const wanted = methods && new Set(methods.map((m) => m.toUpperCase()));
  const onPath = (p, path) => {
    if (typeof p === "string") return p === path;
    p.lastIndex = 0;
    return p.test(path);
  };
  return (m, path) => (wanted === null || wanted.has(m)) && (list === null || (path != null && list.some((p) => onPath(p, path))));
}

/**
 * A predicate over capture rows: a function of the row (one that throws is a
 * non-match), an exact path, a RegExp over the path, or {method, path, op,
 * status}, where `op` and `status` may each be a list.
 */
function captureMatcher(name, pred) {
  if (pred && typeof pred === "object" && !(pred instanceof RegExp) && !Array.isArray(pred)) {
    const { op, ...rest } = pred;
    const base = responseMatcher(rest);
    if (op === undefined) return base;
    const ops = Array.isArray(op) ? op : [op];
    return (r) => base(r) && ops.includes(r.op);
  }
  if (typeof pred === "function" || typeof pred === "string" || pred instanceof RegExp) return responseMatcher(pred);
  throw new Error(`${name}: capture predicate is a function, a path, a RegExp or {method, path, op, status}, got ${pred === null ? "null" : Array.isArray(pred) ? "a list" : typeof pred}`);
}

/** One capture row as a failure message shows it: `POST /suggestion:accept 200`. */
const captureLabel = (r) => `${r.method} ${r.path}${r.op ? `:${r.op}` : ""} ${r.failure ? `failed ${r.failure}` : (r.status ?? r.state)}`;
/** One capture row as the request alone: `POST /suggestion:accept`. */
const captureRequest = (r) => `${r.method} ${r.path}${r.op ? `:${r.op}` : ""}`;

/** waitInTurn's `unansweredMs` is Hosting's cut-off (lib/test.mjs HOSTING_CUTOFF_MS) and this: a request with no answer that long after it was sent has outlived the cut-off itself. */
const IN_TURN_PAST_CUTOFF_MS = 16_000;
/** waitInTurn's `idleMs`: how long a page with none of its requests in flight may change nothing before the wait fails. */
const IN_TURN_IDLE_MS = 30_000;
/** How often waitInTurn reads the rows. */
const IN_TURN_POLL_MS = 50;
/** waitInTurn's options, so a misspelt one, or a `timeout` it does not have, throws instead of being ignored. */
const IN_TURN_OPTIONS = Object.freeze(["since", "settled", "unansweredMs", "idleMs", "what"]);

/** A positive, finite number of ms, or throw naming it. */
function positiveMs(name, key, v, what) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${name}: capture waitInTurn ${key} is ${what}, a positive number of ms, got ${showValue(v)}`);
  return v;
}

/** The longest delayRequests holds one request, whatever its rule says (its `maxMs` default). */
export const DELAY_MAX_MS = 120_000;

/** What failRequests answers with no `body` of its own. */
export const FAIL_BODY = Object.freeze({ error: "e2e: failed on purpose by User.failRequests" });

/**
 * The Firestore web SDK's Listen channel (a WebChannel), on the stack's
 * Firestore origin (delayRequests and failRequests `at: "firestore"`): every
 * snapshot listener of a page is served through it. Its POSTs carry what the
 * page asks for (the first one opens the channel), its GETs are the
 * long-polled back channel. Measured with the app's SDK on a stack.
 */
export const FIRESTORE_LISTEN_PATH = "/google.firestore.v1.Firestore/Listen/channel";

/**
 * The one origin delayRequests and failRequests take requests on: `at`
 * "hosting" is the app's (target.origin), "firestore" the stack's Firestore
 * (firestore-client.mjs firestoreOrigin: target.firestoreUrl). Anything else,
 * or a target that names no Firestore, throws.
 */
function routeOrigin(target, name, at) {
  if (at === "hosting") return new URL(target.origin).origin;
  if (at === "firestore") {
    try {
      return firestoreOrigin(target);
    } catch {
      throw new Error(`${name} at "firestore": target ${target?.runId ?? "(no run id)"} names no firestoreUrl`);
    }
  }
  throw new Error(`${name} at is "hosting" (the app's origin, the default) or "firestore" (the stack's Firestore), got ${showValue(at)}`);
}

/**
 * delayRequests' and failRequests' choice of request: `path` (an exact
 * pathname, or a RegExp over it), `method` (a method, a list, or null for
 * any) and `match` (a predicate of {method, url, path, postJson, postData},
 * or null; one that throws is a non-match), and ONLY on one origin of the
 * stack, `at` (routeOrigin). Returns {url, take}: `url` the route's URL
 * predicate, `take(req)` the request's row fields, or null when it is not one
 * of these.
 */
/** The page a request came from (its frame's page), or null: a request with no frame (a worker's), or one Playwright cannot place. */
function requestPage(req) {
  try {
    return req.frame()?.page() ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `user` owns `page` (User.ownsPage, ONE PERSON IN TWO TABS). An
 * object without ownsPage (a self-test's stand-in for a User) owns every
 * page, as every user did before tabs.
 */
function ownsPageOf(user, page) {
  return typeof user?.ownsPage === "function" ? user.ownsPage(page) : true;
}

/** `user`'s toasts since a toastMark(): `log.toasts` from the mark, less any other tab's (User.toastsSince). */
function ownToasts(user, since) {
  return user.log.toasts.slice(since).filter((t) => ownsPageOf(user, t?.page ?? null));
}

/** What a tab reads and writes on the user its context was made for (ONE PERSON IN TWO TABS): the context's records, one each. */
const CONTEXT_STATE = Object.freeze(["log", "responses", "responseCount", "creating", "email", "analyticsSeen"]);

/** Make `tab` a tab of `root`: its context's records become root's, read and written through. */
function shareContextState(tab, root) {
  for (const key of CONTEXT_STATE) {
    Object.defineProperty(tab, key, {
      get: () => root[key],
      set: (v) => {
        root[key] = v;
      },
      enumerable: true,
      configurable: true,
    });
  }
  tab.tabOf = root;
}

function requestRoute(user, what, path, method, match, at) {
  const name = `${user.name}: ${what}`;
  if (!((typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) || path instanceof RegExp)) {
    throw new Error(`${name} path is a pathname ("/…") or a RegExp over the pathname, got ${showValue(path)}`);
  }
  const methods = method == null ? null : Array.isArray(method) ? method : [method];
  if (methods && (methods.length === 0 || !methods.every((m) => typeof m === "string" && /^[A-Za-z]+$/.test(m)))) {
    throw new Error(`${name} method is a method, a list of them, or null, got ${showValue(method)}`);
  }
  if (match !== null && typeof match !== "function") throw new Error(`${name} match is a function of the request, or null, got ${typeof match}`);
  const wanted = methods && new Set(methods.map((m) => m.toUpperCase()));
  const origin = routeOrigin(user.target, name, at);
  const onPath = (p) => {
    if (typeof path === "string") return p === path;
    path.lastIndex = 0;
    return path.test(p);
  };
  const url = (u) => u.origin === origin && onPath(u.pathname);
  const take = (req) => {
    const m = req.method().toUpperCase();
    if (wanted && !wanted.has(m)) return null;
    // The route is the context's, so it sees every tab's requests: only the user's own (ONE PERSON IN TWO TABS).
    if (!ownsPageOf(user, requestPage(req))) return null;
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return null;
    }
    if (!url(u)) return null;
    let postData = null;
    try {
      postData = req.postData();
    } catch {}
    const row = { method: m, url: req.url(), path: u.pathname, postJson: jsonOrNull(postData) };
    if (match) {
      try {
        if (!match({ ...row, postData })) return null;
      } catch {
        return null;
      }
    }
    return row;
  };
  return { url, take };
}

/** Where the save-state recorders live in the top page: `window[Symbol.for(SAVE_STATES_KEY)]`, a Map from id to recorder. */
export const SAVE_STATES_KEY = "bikeshed-e2e.save-states";

/**
 * Runs in the top page (see THE SAVE STATE, ON THE PAGE'S CLOCK). One
 * recorder: a MutationObserver on the document that reads `.save-state`
 * after every change and keeps a row each time its data-state or text
 * differs from the last row's; a capture-phase `input` listener on each
 * frame document it can reach, added at the call and at each load of a
 * frame matching `frame`. Every row also goes to Node through `binding`, with
 * its index, so a late message cannot duplicate a row a read already took.
 */
function saveStateRecorder({ key, id, binding, frame }) {
  const store = (window[Symbol.for(key)] ??= new Map());
  const now = () => performance.timeOrigin + performance.now();
  const send = (msg) => {
    try {
      window[binding](msg);
    } catch {
      /* the binding is gone during a navigation: the page's rows still hold it */
    }
  };
  const rec = { armedAt: now(), states: [], inputs: [], docs: 0, stopped: false, seen: new WeakSet(), detach: [] };
  const look = () => {
    if (rec.stopped) return;
    const el = document.querySelector(".save-state");
    const s = el ? el.getAttribute("data-state") : null;
    const text = el ? (el.textContent ?? "").trim().slice(0, 200) : null;
    const last = rec.states[rec.states.length - 1];
    if (last && last.s === s && last.text === text) return;
    const row = { i: rec.states.length, s, t: now(), text };
    rec.states.push(row);
    send({ type: "state", ...row });
  };
  const attach = (el) => {
    let d = null;
    try {
      d = el.contentDocument;
    } catch {
      d = null;
    }
    // The initial about:blank of an iframe still loading is not the document; its load attaches that one.
    if (!d || rec.seen.has(d) || d.URL === "about:blank") return;
    rec.seen.add(d);
    rec.docs += 1;
    const onInput = () => {
      if (rec.stopped) return;
      const t = now();
      const i = rec.inputs.length;
      rec.inputs.push(t);
      send({ type: "input", i, t });
    };
    d.addEventListener("input", onInput, true);
    rec.detach.push(() => d.removeEventListener("input", onInput, true));
    send({ type: "doc", docs: rec.docs });
  };
  const frames = () => {
    for (const el of document.querySelectorAll(frame)) attach(el);
  };
  const observer = new MutationObserver(() => {
    look();
    frames();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-state"] });
  // `load` does not bubble, but a capture listener on the document sees an iframe's.
  const onLoad = (e) => {
    const el = e.target;
    if (el && el.nodeType === 1 && el.matches(frame)) attach(el);
  };
  document.addEventListener("load", onLoad, true);
  rec.detach.push(() => {
    observer.disconnect();
    document.removeEventListener("load", onLoad, true);
  });
  look();
  frames();
  rec.snapshot = () => ({ armedAt: rec.armedAt, states: rec.states.map((r) => ({ ...r })), inputs: [...rec.inputs], docs: rec.docs, stopped: rec.stopped });
  rec.stop = () => {
    if (!rec.stopped) {
      look();
      rec.stopped = true;
      for (const f of rec.detach) f();
    }
    return rec.snapshot();
  };
  store.set(id, rec);
  return { armedAt: rec.armedAt };
}

/**
 * What a thread in the comments panel shows of its quote: a comment thread
 * its `.thread-quote`; a suggestion its change (the quote struck in a `<del>`,
 * app/src/annotation/Sidebar.tsx), or, while its Edit form is open, the
 * form's `.suggest-quote`. Not `.suggestion-history del`: those are earlier
 * replacements, not the quote.
 */
const COMMENT_QUOTE = ".thread-quote";
const SUGGESTION_QUOTE = ".suggestion-change del, .suggest-form .suggest-quote";
const THREAD_QUOTE = Object.freeze({
  any: `${COMMENT_QUOTE}, ${SUGGESTION_QUOTE}`,
  comment: COMMENT_QUOTE,
  suggestion: SUGGESTION_QUOTE,
});

/** The floating suggestion form (app/src/components/SuggestPopover.tsx), never a thread's Edit form. */
const SUGGEST_POPOVER = '.suggest-popover, [role="dialog"][aria-label="Suggest an edit"]';
/** The form's request (app/src/annotation: POST /suggestion {op: "create", …}). */
const SUGGESTION_POST = Object.freeze({ method: "POST", path: "/suggestion" });
/**
 * How long User.suggest waits for the page's POST /suggestion entry once the
 * form has closed or its refusal toast has shown. Either follows the answer,
 * so the entry is normally there already; a refusal the form makes without
 * sending anything costs this much once.
 */
const SUGGEST_ANSWER_MS = 2_000;

/**
 * User.suggest's refusal: "<user>: suggestion refused: <toast text>", with
 * `toast` and `response`, the page's latest POST /suggestion entry since
 * `mark` (null when it sent none).
 */
async function suggestRefusal(user, toast, mark) {
  const response = await user.waitForResponse(SUGGESTION_POST, { since: mark, timeout: SUGGEST_ANSWER_MS }).then(
    () => user.findResponses(SUGGESTION_POST, { since: mark }).at(-1) ?? null,
    () => null,
  );
  return Object.assign(new Error(`${user.name}: suggestion refused: ${toast.text}`), { toast, response });
}

/**
 * User.open with `reloads` or `sessionCheck` (see OPENING ON A LOADED STACK
 * in the header): load `path`, wait for the viewer and its frame, and with
 * `sessionCheck` judge the load's own POST /session; load it again after a
 * stall, up to `reloads` times. `label` is the path without its query.
 */
async function openOnLoadedStack(user, { path, label, timeout, reloads, sessionCheck }) {
  const { isHostingCutoff, stackCutoff, stallEvidence } = await import("./test.mjs");
  const origin = new URL(user.target.origin).origin;
  const answerMs = Math.max(timeout, SIGN_IN_TIMEOUT_MS);
  let loads = 0;
  let stall = null;
  for (;;) {
    loads += 1;
    // The POST /session requests this load sends, as they are sent: the first is the load's own.
    const sent = [];
    const onRequest = (req) => {
      try {
        if (req.method() !== "POST") return;
        const url = new URL(req.url());
        if (url.origin === origin && url.pathname === SESSION_POST.path) sent.push({ req, at: now() });
      } catch {
        /* not a URL */
      }
    };
    const began = now();
    user.page.on("request", onRequest);
    try {
      await user.goto(path, { waitUntil: "load", timeout });
      const shown = await user.waitForFrame({ timeout }).then((ready) => ({ ready }), (error) => ({ error }));
      if (shown.error) {
        if (!/ not reached within \d+ ms/.test(String(shown.error?.message))) throw shown.error;
        const seen = stallEvidence([user], began);
        const evidence = [...seen.cut, ...seen.lost];
        if (evidence.length > 0 && loads <= reloads) {
          stall = evidence;
          continue;
        }
        const why = evidence.length > 0 ? `the page saw the stack stall in that load (${evidence.slice(0, 3).join("; ")}${evidence.length > 3 ? `; and ${evidence.length - 3} more` : ""})` : "the page saw no stall of the stack in that load";
        const again = loads > 1 ? `; loaded again after the stack stalled (${stall.slice(0, 2).join("; ")})` : "";
        const err = new Error(`${user.name}: open: the viewer and its document frame not shown within ${timeout} ms of load ${loads} of ${label}: ${why}${again}`, { cause: shown.error });
        err.code = "E2E_NOT_SHOWN";
        err.loads = loads;
        err.stall = evidence;
        throw err;
      }
      if (!sessionCheck) return { ...shown.ready, loads, stall, session: null };
      const sentBy = now() + timeout;
      while (sent.length === 0) {
        if (now() >= sentBy) {
          throw new Error(`${user.name}: open: load ${loads} of ${label} sent no POST /session within ${timeout} ms of its frame showing; sessionCheck is for a signed-in user, whose every load posts its ID token (app/src/auth.tsx)`);
        }
        await sleep(50);
      }
      const { req, at } = sent[0];
      let entry = null;
      for (;;) {
        entry = user.responses.find((r) => r.request === req) ?? null;
        if (entry) break;
        const failure = req.failure();
        if (failure) throw new Error(`${user.name}: open: load ${loads}'s POST /session (${label}) failed after ${now() - at} ms: ${failure.errorText}`);
        if (now() - at >= answerMs) throw new Error(`${user.name}: open: load ${loads}'s POST /session (${label}) got no answer within ${answerMs} ms`);
        await sleep(50);
      }
      const session = { seq: entry.seq, method: entry.method, path: entry.path, status: entry.status, ms: entry.ms };
      if (!isHostingCutoff(entry)) return { ...shown.ready, loads, stall, session };
      if (loads <= reloads) {
        stall = [`${user.name}: POST /session 504 after ${Math.round(entry.ms)} ms`];
        continue;
      }
      const err = stackCutoff(`${user.name}'s POST /session on load ${loads} of ${label}`, entry);
      err.loads = loads;
      throw err;
    } finally {
      user.page.off("request", onRequest);
    }
  }
}

const COMMIT_OUTCOMES = [
  { outcome: "published", re: /^Published (v\d+)\.$/ },
  { outcome: "nochange", re: /^No changes to publish/ },
  { outcome: "conflict", re: /newer version/i },
  { outcome: "save-failed", re: /didn.t save, so nothing was published/ },
];

/** The editor's draft save (app/src/edit.ts saveDraft): POST /draft, never the frame's GET /draft/<docId>/<file>. */
const DRAFT_POST = Object.freeze({ method: "POST", path: "/draft" });

/**
 * When the browser started a request: its own start time (Playwright's
 * timing().startTime, wall-clock ms) when the response carried one, else the
 * moment this process saw the request ("node", which is later).
 */
function requestStart(entry) {
  let t = null;
  try {
    t = entry.request.timing()?.startTime;
  } catch {
    t = null;
  }
  return Number.isFinite(t) && t > 0 ? { startedAt: t, clock: "browser" } : { startedAt: entry.t, clock: "node" };
}

/** A status expectation (a status, a list of them, or null for any) as a list, or null; anything else throws. */
function statusList(name, what, expect) {
  if (expect === null) return null;
  const list = Array.isArray(expect) ? expect : [expect];
  if (list.length === 0 || !list.every((x) => Number.isInteger(x))) {
    throw new Error(`${name}: ${what} expectStatus is a status, a list of them, or null, got ${JSON.stringify(expect)}`);
  }
  return list;
}

/** The viewer's More menu (app/src/components/MoreMenu.tsx): its trigger, and the menu it opens. */
const MORE_TRIGGER = '.viewer-toolbar [aria-label="More actions"]';
const MORE_MENU = '[role="menu"][aria-label="More actions"]';

/**
 * In the page, in one read: the open More menu as groups, or null when it is
 * not open. A group is a heading (`.menu-label`) and the items under it until
 * the next separator or heading; items under no heading are a group whose
 * heading is null (app/src/components/Menu.tsx).
 */
function readMoreMenu(sel) {
  const menu = document.querySelector(sel);
  if (!menu || menu.getClientRects().length === 0) return null;
  const groups = [];
  let cur = null;
  const start = (heading) => {
    cur = { heading, items: [] };
    groups.push(cur);
  };
  for (const el of Array.from(menu.children)) {
    if (el.classList.contains("menu-label")) {
      start((el.textContent ?? "").trim());
    } else if (el.classList.contains("menu-sep")) {
      cur = null;
    } else if (el.getAttribute("role") === "menuitem") {
      if (!cur) start(null);
      cur.items.push({
        label: (el.textContent ?? "").trim(),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        reason: el.getAttribute("title"),
      });
    }
  }
  return groups;
}

/** Open the More menu unless it is open (its trigger is a toggle); resolves its locator. */
async function openMoreMenu(user, timeout) {
  const menu = user.page.locator(MORE_MENU).first();
  if (!(await menu.isVisible().catch(() => false))) {
    await user.page.locator(MORE_TRIGGER).first().click({ timeout });
    await menu.waitFor({ state: "visible", timeout });
  }
  return menu;
}

/** Close the More menu if it is open: Escape, or, when focus is where the menu does not listen, its trigger. */
async function closeMoreMenu(user, timeout) {
  const menu = user.page.locator(MORE_MENU).first();
  if (!(await menu.isVisible().catch(() => false))) return;
  await user.page.keyboard.press("Escape");
  if (await menu.waitFor({ state: "detached", timeout: Math.min(3_000, timeout) }).then(() => true, () => false)) return;
  await user.page.locator(MORE_TRIGGER).first().click({ timeout });
  await menu.waitFor({ state: "detached", timeout });
}

/** A RegExp matching exactly `text`, give or take surrounding whitespace. */
const exactText = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

/** Where comment() keeps the thread elements on the page before its press: `window[Symbol.for(THREADS_KEY)]`, a WeakSet (no node, no attribute). */
const THREADS_KEY = "bikeshed-e2e.threads-before";

/** In the page: remember every comment thread element now on the page. */
function rememberThreads(key) {
  window[Symbol.for(key)] = new WeakSet(document.querySelectorAll(".comments-panel .thread"));
}

/** In the page: the selected thread that was not on the page at rememberThreads, null while there is none, "forgotten" after a navigation. */
function newSelectedThread(key) {
  const before = window[Symbol.for(key)];
  if (!before) return "forgotten";
  return Array.from(document.querySelectorAll('.comments-panel .thread[aria-selected="true"]')).find((el) => !before.has(el)) ?? null;
}

/** In the page: has `el` shown a `.comment-body` holding `text`? "gone" once it has left the page. */
function threadShows([el, text]) {
  if (!el.isConnected) return "gone";
  return Array.from(el.querySelectorAll(".comment-body")).some((b) => (b.textContent ?? "").includes(text) && b.getClientRects().length > 0) ? "shown" : false;
}

/**
 * What the Firestore emulator's rules say when a rule's get() failed, rather
 * than the rules refusing ("Service call error. Function: [get], Argument:
 * [path_value {…}]"), shown in the app's error toast. On a loaded shared
 * stack it is the emulator failing (seen in a05, a17 and a24), not the
 * rules' verdict. User.comment's `retryServiceError` and
 * User.pressRetryingServiceError read it.
 */
export const RULES_SERVICE_ERROR_RE = /\bService call error\b/;
/** How long comment() (and pressRetryingServiceError, by default) waits after a press the emulator refused so, before the next: a back-off for the emulator, not a wait on the product. */
const SERVICE_RETRY_MS = 3_000;

/**
 * What User.reply, resolve and reopen wait at most for EACH of their waits
 * when not told: the panel, the thread's control, the outcome. Never less
 * than any of those waits had before `timeout` bounded them all (the panel
 * 10 s, a press Playwright's 30 s, the outcome 20 s).
 */
const THREAD_ACTION_MS = 30_000;

/** The thread a reply, resolve or reopen acts on, in its error: by its quote, or the selected one. */
const threadName = (quote) => (quote == null ? "the selected thread" : `the thread quoting ${JSON.stringify(quote)}`);

/** A Playwright wait that ran out, in its own words or its error class. */
const playwrightTimedOut = (err) => err?.name === "TimeoutError" || /\bTimeout \d+ ?ms exceeded\b/.test(String(err?.message));

/** A reply, resolve or reopen's `timeout`: a positive number of ms, or it throws before anything is pressed. */
function threadTimeout(u, verb, timeout) {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`${u.name}: ${verb} timeout is a positive number of ms, bounding each of its waits, got ${showValue(timeout)}`);
}

/**
 * Press `control`, a locator inside the thread quoting `quote`, for
 * User.reply, resolve or reopen: Playwright's click, which waits for it to be
 * listed, visible, stable and enabled, up to `timeout`. When that runs out it
 * throws "<user>: <verb>: <thread> showed no <what> to press within <timeout>
 * ms (<n> such thread(s) in the panel)", Playwright's error as its cause: 0
 * threads is a thread this page's snapshot never delivered. Anything else
 * (a closed page) is thrown as it is.
 */
async function pressInThread(u, verb, quote, control, what, timeout) {
  try {
    await control.click({ timeout });
  } catch (err) {
    if (u.page.isClosed() || !playwrightTimedOut(err)) throw err;
    const n = await u.thread(quote).count().catch(() => null);
    throw new Error(`${u.name}: ${verb}: ${threadName(quote)} showed no ${what} to press within ${timeout} ms (${n ?? "?"} such thread${n === 1 ? "" : "s"} in the panel)`, { cause: err });
  }
}

/** One Comment press and its comment, as User.comment documents it: {quote}. */
async function commentPress(u, text, timeout) {
  const page = u.page;
  let deadline = now() + timeout;
  // One Playwright step is never given less than 2 s: see openComments.
  const left = () => Math.max(deadline - now(), 2_000);
  const since = u.toastMark();
  await page.evaluate(rememberThreads, THREADS_KEY);
  await page.locator(".selection-fab", { hasText: /^\s*Comment\s*$/ }).first().click({ timeout: left() });
  let thread = null;
  for (;;) {
    // A navigation in flight destroys the context mid-read; the next read says "forgotten".
    const h = await page.evaluateHandle(newSelectedThread, THREADS_KEY).catch((e) => (page.isClosed() ? Promise.reject(e) : null));
    thread = h?.asElement() ?? null;
    if (thread) break;
    const v = h ? await h.jsonValue().catch(() => null) : null;
    await h?.dispose().catch(() => undefined);
    if (v === "forgotten") throw new Error(`${u.name}: the page navigated after the Comment press, so the thread it made cannot be told from the others`);
    const err = ownToasts(u, since).find((t) => t.kind === "error");
    if (err) throw Object.assign(new Error(`${u.name}: the Comment press made no thread: the app said ${JSON.stringify(err.text)}`), { toast: err });
    if (now() >= deadline) {
      const selected = await page.locator('.comments-panel .thread[aria-selected="true"]').count().catch(() => null);
      throw new Error(`${u.name}: no new thread was selected within ${timeout} ms of the Comment press (${selected ?? "?"} selected thread(s), all from before it)`);
    }
    await sleep(100);
  }
  deadline = now() + timeout; // the second wait: the comment in the new thread
  try {
    const box = await thread.waitForSelector('textarea[placeholder="Reply"]', { state: "visible", timeout: left() });
    await box.click({ timeout: left() });
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    let shown;
    try {
      shown = await (await page.waitForFunction(threadShows, [thread, text], { timeout: left(), polling: 100 })).jsonValue();
    } catch (e) {
      if (page.isClosed()) throw e;
      const holders = await page
        .evaluate((t) => Array.from(document.querySelectorAll(".comments-panel .thread")).filter((th) => Array.from(th.querySelectorAll(".comment-body")).some((b) => (b.textContent ?? "").includes(t))).length, text)
        .catch(() => null);
      throw new Error(`${u.name}: the comment did not show in the thread the Comment press made within ${timeout} ms (${holders ?? "?"} thread(s) on the page hold it)`);
    }
    if (shown === "gone") throw new Error(`${u.name}: the thread the Comment press made left the page before the comment showed in it`);
    return { quote: (await thread.$eval(".thread-quote", (q) => q.textContent).catch(() => null))?.trim() ?? null };
  } finally {
    await thread.dispose().catch(() => undefined);
  }
}

/** Where capturePrint keeps its record in the app's window: `window[Symbol.for(PRINT_KEY)]` (no node, no attribute). */
export const PRINT_KEY = "bikeshed-e2e.print";
/** How many print() calls capturePrint snapshots per frame; later calls are counted only. */
export const PRINT_MAX_SNAPS = 10;

/**
 * In the app's window (see the header, and capturePrint): from now on, every
 * iframe added anywhere in the document, except those matching `cfg.exclude`
 * (the reading frame), is a row whose window's print() is replaced by a
 * recorder, at once and again at each `load` of the frame. With `cfg.match`
 * (a selector), an iframe that does not match it is no row and is never
 * hooked: it is listed in `ignored` only. A call snapshots
 * the frame's document: its doctype and `outerHTML`, title and URL, and
 * `extract(document, arg)` when one is given. Arming again replaces the
 * previous recorder. Sent as source (see capturePrint), so it closes over
 * nothing.
 */
function printRecorder(cfg, extract, arg) {
  const sym = Symbol.for(cfg.key);
  window[sym]?.disarm?.();
  const rec = { armedAt: Date.now(), frames: [], ignored: [] };
  const seen = new WeakSet();
  const doctype = (d) => {
    const t = d.doctype;
    if (!t) return "";
    return `<!DOCTYPE ${t.name}${t.publicId ? ` PUBLIC "${t.publicId}"` : ""}${t.systemId ? `${t.publicId ? "" : " SYSTEM"} "${t.systemId}"` : ""}>\n`;
  };
  const snapshot = (el) => {
    const s = { t: Date.now(), html: null, title: null, url: null, error: null, extra: null, extractError: null };
    let d = null;
    try {
      d = el.contentDocument;
      s.html = `${doctype(d)}${d.documentElement.outerHTML}`;
      s.title = d.title;
      s.url = d.URL;
    } catch (e) {
      s.error = String(e?.message ?? e);
    }
    if (extract) {
      try {
        s.extra = extract(d, arg) ?? null;
      } catch (e) {
        s.extractError = String(e?.stack ?? e);
      }
    }
    return s;
  };
  const hook = (el, r, recorder) => {
    let w = null;
    try {
      w = el.contentWindow;
    } catch (e) {
      r.hookError = String(e?.message ?? e);
      return;
    }
    if (!w) {
      r.hookError = "the iframe has no window";
      return;
    }
    try {
      if (w.print === recorder) return;
      w.print = recorder;
      if (w.print !== recorder) throw new Error("its window kept its own print()");
      r.hooks += 1;
      r.hookError = null;
    } catch (e) {
      r.hookError = String(e?.message ?? e);
    }
  };
  const consider = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.matches(cfg.exclude)) return;
    if (cfg.match && !el.matches(cfg.match)) {
      rec.ignored.push({ t: Date.now(), sandbox: el.getAttribute("sandbox"), className: el.getAttribute("class"), src: el.getAttribute("src") });
      return;
    }
    const r = { index: rec.frames.length, t: Date.now(), sandbox: el.getAttribute("sandbox"), className: el.getAttribute("class"), src: el.getAttribute("src"), printed: 0, hooks: 0, hookError: null, snaps: [] };
    const recorder = function print() {
      r.printed += 1;
      if (r.snaps.length < cfg.maxSnaps) r.snaps.push(snapshot(el));
    };
    rec.frames.push(r);
    el.addEventListener("load", () => hook(el, r, recorder));
    hook(el, r, recorder);
  };
  const visit = (n) => {
    if (n.nodeType !== 1) return;
    if (n.localName === "iframe") consider(n);
    for (const f of n.querySelectorAll("iframe")) consider(f);
  };
  const observer = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) visit(n);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window[sym] = { rec, disarm: () => observer.disconnect() };
  return rec.armedAt;
}

/** In the page: how far a capture has got, without copying its snapshots; null when the recorder is gone (a navigation). */
function printProgress(key) {
  const s = window[Symbol.for(key)];
  if (!s) return null;
  return { frames: s.rec.frames.length, unprinted: s.rec.frames.filter((f) => f.printed === 0).length, ignored: (s.rec.ignored ?? []).length, rows: s.rec.frames.map((f) => ({ index: f.index, sandbox: f.sandbox, className: f.className, printed: f.printed, hooks: f.hooks, hookError: f.hookError })) };
}

/** A function's source as an expression the page can call (method shorthand included); throws when it has none. */
function functionSource(fn, what) {
  const src = Function.prototype.toString.call(fn).trim();
  const forms = [src, src.startsWith("async ") ? `async function ${src.slice(6)}` : `function ${src}`];
  for (const s of forms) {
    try {
      new Function(`return (${s});`); // eslint-disable-line no-new-func -- a syntax check only, nothing runs
      return `(${s})`;
    } catch {
      /* the next form */
    }
  }
  throw new Error(`${what} is a function written in the spec (its source is sent to the page), got one with no source: ${src.slice(0, 80)}`);
}

/** The default page printRenderer renders: A4 in CSS pixels at 96 dpi. */
export const PRINT_PAGE = Object.freeze({ width: 794, height: 1123 });
const RENDER_MEDIA = Object.freeze(["print", "screen", null]);
/** How many aborted request URLs a renderer keeps. */
const RENDER_BLOCKED_MAX = 1000;

/** In a renderer's page: "settled" once its fonts are ready and two animation frames have passed, or "timeout" after `ms`. */
function settlePage(ms) {
  return Promise.race([
    document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r("settled"))))),
    new Promise((r) => setTimeout(() => r("timeout"), ms)),
  ]);
}

/** Wait, in a renderer's page, for what settlePage waits for; throw when it does not within `timeout`. */
async function settleRender(page, timeout) {
  const out = await page.evaluate(settlePage, timeout);
  if (out !== "settled") throw new Error(`printRenderer render: the page did not settle (its fonts ready, then two animation frames) within ${timeout} ms`);
}

/** In a renderer's page: each element matching `selector`, with its box and the computed `properties`. */
function readComputed({ selector, properties }) {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.localName,
      id: el.id || null,
      className: el.getAttribute("class"),
      text: (el.textContent ?? "").trim().slice(0, 500),
      rect: [r.x, r.y, r.width, r.height],
      computed: Object.fromEntries(properties.map((p) => [p, cs.getPropertyValue(p)])),
    };
  });
}

/** printRenderer's `regions`, checked: {name: {x, y, w, h, color = null, tol = 70, minDiff = 30}}. */
function renderRegions(regions) {
  if (regions === null) return null;
  if (!regions || typeof regions !== "object" || Array.isArray(regions) || Object.keys(regions).length === 0) {
    throw new Error(`printRenderer render: regions is {name: {x, y, w, h, color, tol, minDiff}} with at least one, or null, got ${showValue(regions)}`);
  }
  return Object.entries(regions).map(([name, r]) => {
    if (!r || !["x", "y", "w", "h"].every((k) => Number.isInteger(r[k]))) throw new Error(`printRenderer render: region ${JSON.stringify(name)} is {x, y, w, h} in whole pixels, got ${showValue(r)}`);
    return [name, { region: { x: r.x, y: r.y, w: r.w, h: r.h }, color: r.color ?? null, tol: r.tol ?? 70, minDiff: r.minDiff ?? 30 }];
  });
}

/**
 * Whether a request a page sent CREATES something on the target, and what:
 *   POST /publish without `update`        {kind: "doc", via: "upload-ui"}
 *   POST /folder                          {kind: "folder", via: "folder-ui", parentId}
 *   POST /fork with {op: "create", docId} {kind: "doc", via: "fork-ui", forkOf}
 * else null. Only on `origin` (the target's): a request anywhere else is not
 * the product's. `postJson` is the request's body parsed as JSON, or null.
 */
export function pageCreation(method, rawUrl, postJson, origin) {
  if (String(method).toUpperCase() !== "POST") return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.origin !== new URL(origin).origin) return null;
  const body = postJson && typeof postJson === "object" && !Array.isArray(postJson) ? postJson : null;
  if (u.pathname === "/publish") return u.searchParams.has("update") ? null : { kind: "doc", via: "upload-ui" };
  if (u.pathname === "/folder") return { kind: "folder", via: "folder-ui", parentId: typeof body?.parentId === "string" && body.parentId ? body.parentId : null };
  if (u.pathname === "/fork" && body?.op === "create") return { kind: "doc", via: "fork-ui", forkOf: typeof body.docId === "string" && body.docId ? body.docId : null };
  return null;
}

/** Read a creation's answer and ledger what it made (see WHAT A PAGE CREATED): never throws, the row says what happened. */
async function ledgerCreation(user, what, res) {
  const row = { t: now(), kind: what.kind, via: what.via, id: null, ledgered: false, error: null };
  user.log.created.push(row);
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    row.error = `the answer could not be read as JSON: ${err?.message ?? err}`;
    return row;
  }
  const id = what.kind === "doc" ? json?.docId : json?.folderId;
  if (typeof id !== "string" || id === "") {
    row.error = `the answer named no ${what.kind === "doc" ? "docId" : "folderId"}`;
    return row;
  }
  row.id = id;
  try {
    const common = { via: what.via, ownerEmail: typeof user.email === "string" && user.email ? user.email : null, actor: user.name };
    if (what.kind === "doc") {
      ledgerDoc(user.target, { ...common, docId: id, versionId: typeof json.versionId === "string" && json.versionId ? json.versionId : null, ...(what.forkOf ? { forkOf: what.forkOf } : {}) });
    } else {
      ledgerFolder(user.target, { ...common, folderId: id, parentId: what.parentId ?? null, name: typeof json.name === "string" && json.name ? json.name : null });
    }
    row.ledgered = true;
  } catch (err) {
    row.error = String(err?.message ?? err);
  }
  return row;
}

/** The drag events dropFiles may dispatch: what a drop from the desktop fires on the page. */
export const DROP_EVENT_TYPES = Object.freeze(["dragenter", "dragover", "dragleave", "drop"]);
/** What dropFiles dispatches unless told otherwise: a drag that enters, hovers and drops. */
export const DROP_EVENTS = Object.freeze(["dragenter", "dragover", "drop"]);

/** In the page: build a DataTransfer of real Files and dispatch the drag events on `el`; per event, whether the page claimed it. */
function dispatchDrop(el, { payload, events }) {
  const dt = new DataTransfer();
  for (const f of payload) {
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  return events.map((type) => ({ type, claimed: !el.dispatchEvent(new DragEvent(type, init)) }));
}

/** The label of a toast's own dismiss button (app/src/components/Toast.tsx). */
export const TOAST_DISMISS_LABEL = "Dismiss";
/** Where dismissToasts keeps the toasts it pressed, in the page: `window[Symbol.for(DISMISSED_KEY)]`. */
const DISMISSED_KEY = "bikeshed-e2e.dismissed-toasts";

export class User {
  constructor(pool, { name, context, page, device = DESKTOP_DEVICE }) {
    this.pool = pool;
    this.target = pool.target;
    this.name = name;
    this.context = context;
    this.page = page;
    /** What the context was made as: {width, height, touch}, frozen (the desktop, 1280×800 with a mouse, unless user() was given one). */
    this.device = device;
    this.email = null;
    this.log = { console: [], errors: [], requests: [], toasts: [], breaches: [], external: [], websockets: [], sdkProbes: [], created: [], wsFrames: wsFrameLog() };
    /** The creations whose answer is still being read and ledgered (see settleCreated). */
    this.creating = new Set();
    /** throttleCpu's state per page: {session: Promise<CDPSession>, active: [{rate}]}, the latest last. */
    this.cpuThrottles = new WeakMap();
    /** Every response this context received, oldest first (the last 5000). Live objects: never serialise them. */
    this.responses = [];
    /** How many responses were ever recorded; the next one's `seq`. */
    this.responseCount = 0;
    this.closed = false;
    // Whether this user went into the editor (enterEdit, or awaitEdit after a
    // press made elsewhere) and has not left it
    // through done() or a commit that published: settleLive (lib/live.mjs)
    // reads a missing save state on such a user as "left edit mode".
    this.inEdit = false;
    /** The user whose context this tab is (newTab), or null: this user's context was made for it. */
    this.tabOf = null;
    /** The tabs newTab opened on this user's context, in order, closed ones included (their pages stay theirs). */
    this.tabs = [];
  }

  url(path) {
    return new URL(path, this.target.origin).href;
  }

  /**
   * Whether what `page` sent or showed is this user's (see ONE PERSON IN TWO
   * TABS in the header): a tab owns its own page only; the user its context
   * was made for owns every page no tab of it claims, and anything with no
   * page (null). With no tab, every page.
   */
  ownsPage(page) {
    if (this.tabOf) return page != null && page === this.page;
    if (this.tabs.length === 0 || page == null) return true;
    return !this.tabs.some((t) => t.page === page);
  }

  /**
   * Another tab of the same person: a new page in this user's context (the
   * same cookies, storage and signed-in account, and the context's
   * instrumentation), driven as a User of its own (see ONE PERSON IN TWO
   * TABS in the header). `name` is the tab's (default `<user>-tab<k>`, k = 2,
   * 3, … in the order tabs are asked for); one this context already gives a
   * tab or the user throws. A tab's newTab opens a tab of the same user:
   * tabs are flat, all in `tabs` of the user the context was made for, which
   * is the tab's `tabOf`. The pool's memory gate is asked for one context's
   * room first (a tab is a renderer of its own), as user() asks it, and its
   * E2E_INCONCLUSIVE leaves no tab behind. The tab is never in `pool.users`:
   * its rows are already the user's, and the pool's close() reaches it
   * through the user's context.
   */
  async newTab({ name = null } = {}) {
    const root = this.tabOf ?? this;
    if (name !== null && (typeof name !== "string" || name.trim() === "")) throw new TypeError(`${root.name}: newTab name is a non-empty string, or null for "${root.name}-tab<k>", got ${showValue(name)}`);
    if (root.closed) throw new Error(`${root.name}: newTab: this user is closed, and its context with it`);
    if (root.pool.closing || root.pool.closed) throw new Error("pool is closed");
    const taken = (n) => n === root.name || root.tabs.some((t) => t.name === n);
    // Named and claimed synchronously: tabs asked for concurrently must not take the same name.
    let tabName = name;
    if (tabName === null) {
      do {
        root.tabSeq = (root.tabSeq ?? 1) + 1;
        tabName = `${root.name}-tab${root.tabSeq}`;
      } while (taken(tabName));
    } else if (taken(tabName)) {
      throw new Error(`${root.name}: newTab: ${JSON.stringify(tabName)} already names this user or one of its tabs`);
    }
    const tab = new User(root.pool, { name: tabName, context: root.context, page: null, device: root.device });
    shareContextState(tab, root);
    root.tabs.push(tab);
    try {
      await root.pool.admitContexts(1);
      if (root.closed || root.pool.closing || root.pool.closed) throw new Error(`${root.name}: newTab: ${root.closed ? "the user was closed" : "the pool was closed"} while the tab waited for memory`);
      tab.page = await root.context.newPage();
      if (process.env.E2E_RTDB_COVERAGE_RECYCLE === "1") await preserveFirestoreResponses(root.pool.target, root.context, tab.page);
    } catch (err) {
      root.tabs.splice(root.tabs.indexOf(tab), 1);
      throw err;
    }
    return tab;
  }

  /**
   * Answer every analytics request this user's context makes from here, and
   * count it: nothing is ever sent (see the header). Call it BEFORE the page
   * loads anything that may start analytics, straight after creating the
   * user. Resolves `seen`, a live array with one row per request, in the
   * order the route saw them: `{t, user, kind, method, host, path, id,
   * status}`. `kind` is analyticsRequest's ("gtag", "collect", "web-config",
   * "installations"), `id` the URL's `id` (gtag's measurement id) or `tid`
   * parameter, else null, `status` what it was answered. The measurement
   * script is ANALYTICS_SCRIPT_STUB (nothing runs, so nothing is collected),
   * a collection request 204, the web config `{appId, measurementId}`, an
   * installation a made-up one.
   *
   * `measurementId` is what the web config names, so the id gtag is then
   * loaded for: measurement-id-shaped, by default the stack's own
   * (target.options.appEnv) or else a fresh dummy. It is on the array too,
   * as `seen.measurementId` (not enumerable). A second call returns the same
   * array; one naming another id throws. Rows hold URLs' paths, which on
   * production name the deployment's app id: write them to evidence only
   * through ctx.ev.
   */
  async fulfilAnalytics({ measurementId } = {}) {
    if (measurementId !== undefined && !isMeasurementIdShape(measurementId)) throw new Error("fulfilAnalytics: measurementId is a measurement-id-shaped value (options.mjs dummyMeasurementId makes one)");
    if (this.analyticsSeen) {
      if (measurementId !== undefined && measurementId !== this.analyticsSeen.measurementId) throw new Error("fulfilAnalytics: already answering with another measurement id for this user");
      return this.analyticsSeen;
    }
    const own = this.target.options?.appEnv?.VITE_FIREBASE_MEASUREMENT_ID;
    const id = measurementId ?? (isMeasurementIdShape(own) ? own : dummyMeasurementId());
    const seen = [];
    Object.defineProperty(seen, "measurementId", { value: id, enumerable: false });
    this.analyticsSeen = seen;
    const user = this;
    await this.context.route(
      (url) => analyticsRequest(url.href) !== null || analyticsRequest(url.href, { method: "POST" }) !== null || analyticsRequest(url.href, { method: "DELETE" }) !== null,
      async (route) => {
        const req = route.request();
        const hit = analyticsRequest(req.url(), { method: req.method() });
        // A URL the matcher took for another method (a PUT of the web config): the tripwire's.
        if (!hit) return route.fallback();
        let postJson = null;
        try {
          postJson = req.postDataJSON();
        } catch {
          /* not JSON */
        }
        const url = new URL(req.url());
        const answer = analyticsAnswer(hit, { measurementId: id, postJson });
        seen.push({ t: now(), user: user.name, kind: hit.kind, method: req.method(), host: url.hostname, path: url.pathname, id: url.searchParams.get("id") ?? url.searchParams.get("tid") ?? null, status: answer.status });
        return route
          .fulfill({ status: answer.status, ...(answer.contentType ? { contentType: answer.contentType } : {}), body: answer.body })
          .catch(() => undefined);
      },
    );
    return seen;
  }

  /** A mark for findResponses and waitForResponse: the `seq` the next response will get. Take it BEFORE acting. */
  responseMark() {
    return this.responseCount;
  }

  /**
   * Responses since a mark that match `pred`, oldest first, of the pages
   * this user owns (ownsPage: every page, unless the context has tabs). Each
   * is {seq, t, at, ms, method, url, path, query, type, status, headers,
   * requestHeaders, postData, postBuffer, postJson, response, request}, plus
   * a non-enumerable `page` (null when the request had none).
   */
  findResponses(pred = () => true, { since = 0 } = {}) {
    const test = responseMatcher(pred);
    return this.responses.filter((r) => r.seq >= since && ownsPageOf(this, r.page ?? null) && test(r));
  }

  /**
   * The first response since a mark that matches `pred`, of the pages this
   * user owns (as findResponses), waiting for it if it has not arrived.
   * Unlike page.waitForResponse, one that arrived before this call counts,
   * so a fast response is never missed between the act and the wait.
   */
  async waitForResponse(pred, { since = 0, timeout = 30_000 } = {}) {
    const test = responseMatcher(pred);
    const deadline = now() + timeout;
    for (;;) {
      const hit = this.responses.find((r) => r.seq >= since && ownsPageOf(this, r.page ?? null) && test(r));
      if (hit) return hit;
      if (now() >= deadline) break;
      await sleep(50);
    }
    const seen = this.responses.filter((r) => r.seq >= since && ownsPageOf(this, r.page ?? null)).slice(-8).map((r) => `${r.method} ${r.path} ${r.status}`).join(" | ") || "none";
    throw new Error(`${this.name}: no matching response within ${timeout} ms (last seen: ${seen})`);
  }

  /**
   * Record the requests this user's pages send from now on that match `paths`
   * and `method` (POST by default; null for any), one row each in the order
   * they were sent (see the header). Returns a live array of rows:
   *   {seq, method, url, path, type, op, postJson, t, sentAt, respondedAt, doneAt,
   *    status, json, failure, state: "sent"|"answered"|"finished"|"failed", settled}
   * `type` is the request's resource type ("fetch", "xhr", "document",
   * "image", …). Every request STARTED from now on, whatever its path and
   * method, is `capture({method: null})`: an absence oracle reads it, since
   * a request that never got an answer is a row here and in no other log.
   * `postJson` is the request's body parsed as JSON (null when it is not
   * JSON), `op` its string `op` field or null. `json` is the response's body
   * parsed as JSON, read once it has finished (null when it is not JSON, or
   * with `responseJson: false`). `settled` is true once the row will not
   * change again. A request already in flight at the call is never a row.
   * The array also has `mark()` (the seq the next row will get), `waitFor(pred,
   * {since, timeout, settled = true})` and `stop()`, which stops new rows and
   * lets the rows in flight complete. The oldest rows go beyond `max`.
   *
   * `waitInTurn(pred, {since = 0, settled = true, unansweredMs =
   * HOSTING_CUTOFF_MS + 16_000, idleMs = 30_000, what = "waitInTurn"})` →
   * the row: the first row since `since` that matches `pred` (as waitFor's),
   * once settled (`settled: false`: once sent), waited for while the page
   * works through the requests before it (see A PAGE'S CHAIN OF REQUESTS in
   * the header). It reads every row from `since`, and from any row still
   * unsettled as it starts (a save under way holds up what follows it):
   *   - each answer goes through lib/test.mjs answered(): Hosting's cut-off
   *     504 to any of them throws E2E_STACK_CUTOFF ("<user>'s page's POST
   *     /draft (<what>) answered 504 after N ms, …"), a quicker one is an
   *     answer, returned when it matches;
   *   - a row still `sent` `unansweredMs` after it was sent (one sent before
   *     the wait began: after the wait began, since the case may have held
   *     it) throws E2E_STACK_CUTOFF, `stackCut` "<user>'s page's <request>
   *     (#seq, <what>) got no answer in N ms, …", `response` null;
   *   - with no row `sent`, rows that do not change for `idleMs` throw Error
   *     "<user>: <what>: the page sent nothing more within <idleMs> ms, with
   *     none of its requests in flight (captured since <since>: …)" (or
   *     "#n matched but had not settled (<state>), and nothing changed
   *     within …").
   * No other deadline: the case's own bounds it. A request the browser failed
   * settles like any other. Arguments are checked before anything waits; an
   * unknown option (a `timeout`) throws.
   */
  capture({ paths = null, method = "POST", responseJson = true, max = NETWORK_LOG_MAX } = {}) {
    const name = this.name;
    const accept = captureFilter(name, paths, method);
    if (!Number.isInteger(max) || max < 1) throw new Error(`${name}: capture max is a positive integer, got ${showValue(max)}`);
    const context = this.context;
    const owner = this;
    const rows = [];
    const live = new Map();
    let count = 0;
    let stopped = false;
    let attached = true;
    const onRequest = (req) => {
      if (stopped) return;
      const method = req.method();
      let path = null;
      try {
        path = new URL(req.url()).pathname;
      } catch {}
      if (!accept(method, path)) return;
      // Another tab's request is that tab's (ONE PERSON IN TWO TABS); with no tab, every page's.
      const page = requestPage(req);
      if (!ownsPageOf(owner, page)) return;
      let postData = null;
      try {
        postData = req.postData();
      } catch {}
      const postJson = jsonOrNull(postData);
      const op = postJson && typeof postJson === "object" && !Array.isArray(postJson) && typeof postJson.op === "string" ? postJson.op : null;
      const row = {
        seq: count,
        method,
        url: req.url(),
        path,
        type: req.resourceType(),
        op,
        postJson,
        t: now(),
        sentAt: performance.now(),
        respondedAt: null,
        doneAt: null,
        status: null,
        json: null,
        failure: null,
        state: "sent",
        settled: false,
      };
      Object.defineProperty(row, "request", { value: req, enumerable: false });
      Object.defineProperty(row, "page", { value: page, enumerable: false });
      count += 1;
      rows.push(row);
      if (rows.length > max) rows.splice(0, rows.length - max);
      live.set(req, row);
    };
    const onResponse = (res) => {
      const row = live.get(res.request());
      if (!row) return;
      row.respondedAt = performance.now();
      row.status = res.status();
      row.state = "answered";
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfinished", onFinished);
      context.off("requestfailed", onFailed);
    };
    const settle = (row) => {
      row.settled = true;
      if (stopped && live.size === 0) detach();
    };
    // The finish's time is taken at the event, before the body is read, so it is the browser's order, not the read's.
    async function onFinished(req) {
      const row = live.get(req);
      if (!row) return;
      live.delete(req);
      row.doneAt = performance.now();
      row.state = "finished";
      try {
        const res = await req.response();
        if (res && row.status === null) row.status = res.status();
        if (res && responseJson) row.json = jsonOrNull((await res.body()).toString("utf8"));
      } catch {
        /* a redirect's or an evicted body: json stays null */
      }
      settle(row);
    }
    function onFailed(req) {
      const row = live.get(req);
      if (!row) return;
      live.delete(req);
      row.doneAt = performance.now();
      row.failure = req.failure()?.errorText ?? "failed";
      row.state = "failed";
      settle(row);
    }
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfinished", onFinished);
    context.on("requestfailed", onFailed);
    const waitFor = async (test, { since, timeout, settled }) => {
      const deadline = now() + timeout;
      for (;;) {
        const hit = rows.find((r) => r.seq >= since && test(r));
        if (hit && (!settled || hit.settled)) return hit;
        if (now() >= deadline) {
          const seen = rows.filter((r) => r.seq >= since).slice(-8).map(captureLabel).join(" | ") || "none";
          const why = hit ? `#${hit.seq} matched but had not settled (${hit.state})` : "none matched";
          throw new Error(`${name}: no ${settled ? "settled " : ""}captured request within ${timeout} ms: ${why} (captured since ${since}: ${seen})`);
        }
        await sleep(25);
      }
    };
    const waitInTurn = async (test, { since, settled, unansweredMs, idleMs, what }) => {
      const { answered, HOSTING_CUTOFF_MS } = await import("./test.mjs");
      const { redactString } = await import("./evidence.mjs");
      const noAnswerMs = unansweredMs ?? HOSTING_CUTOFF_MS + IN_TURN_PAST_CUTOFF_MS;
      // Rows still in flight as it starts are the page's too: a save under way holds up what follows it.
      const from = Math.min(since, ...rows.filter((r) => !r.settled).map((r) => r.seq));
      const began = performance.now();
      // A request's time without an answer counts from its send, or from this wait's start when it was sent before:
      // a request the case held itself (delayRequests, sync.mjs holdRequests) reached the stack only when let go.
      const unansweredFor = (r, t) => t - Math.max(r.sentAt, began);
      let shape = null;
      let movedAt = began;
      for (;;) {
        const mine = rows.filter((r) => r.seq >= from);
        for (const r of mine) if (r.status != null) answered(r, `${name}'s page's ${captureRequest(r)} (${what})`);
        const hit = mine.find((r) => r.seq >= since && test(r));
        if (hit && (!settled || hit.settled)) return hit;
        const t = performance.now();
        const stuck = mine.find((r) => r.state === "sent" && unansweredFor(r, t) >= noAnswerMs);
        if (stuck) {
          const past = noAnswerMs >= HOSTING_CUTOFF_MS ? `past Hosting's own cut-off of ${HOSTING_CUTOFF_MS} ms: the stack did not answer it` : `the wait's unansweredMs of ${noAnswerMs} ms`;
          const before = stuck.sentAt < began ? ` (${Math.round(unansweredFor(stuck, t))} ms of them in this wait, which began after it was sent)` : "";
          const reason = redactString(`${name}'s page's ${captureRequest(stuck)} (#${stuck.seq}, ${what}) got no answer in ${Math.round(t - stuck.sentAt)} ms${before}, ${past}`);
          const err = new Error(reason);
          err.code = "E2E_STACK_CUTOFF";
          err.stackCut = reason;
          err.response = null;
          throw err;
        }
        const nowShape = mine.map((r) => `${r.seq}:${r.state}`).join(",");
        if (nowShape !== shape) {
          shape = nowShape;
          movedAt = t;
        }
        if (!mine.some((r) => r.state === "sent") && t - movedAt >= idleMs) {
          const seen = mine.filter((r) => r.seq >= since).slice(-8).map(captureLabel).join(" | ") || "none";
          const why = hit ? `#${hit.seq} matched but had not settled (${hit.state}), and nothing changed within ${idleMs} ms` : `the page sent nothing more within ${idleMs} ms`;
          throw new Error(`${name}: ${what}: ${why}, with none of its requests in flight (captured since ${since}: ${seen})`);
        }
        await sleep(IN_TURN_POLL_MS);
      }
    };
    Object.defineProperties(rows, {
      mark: { value: () => count },
      waitFor: {
        // The predicate and `since` are checked before anything waits, so a mistake throws at once.
        value: (pred, { since = 0, timeout = 30_000, settled = true } = {}) => {
          const test = captureMatcher(name, pred);
          if (!Number.isInteger(since) || since < 0) throw new Error(`${name}: capture waitFor since is a mark() (a seq), got ${showValue(since)}`);
          return waitFor(test, { since, timeout, settled });
        },
      },
      waitInTurn: {
        // Every argument is checked before anything waits, so a mistake throws at once.
        value: (pred, options = {}) => {
          const test = captureMatcher(name, pred);
          if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error(`${name}: capture waitInTurn options are {${IN_TURN_OPTIONS.join(", ")}}, got ${showValue(options)}`);
          const unknown = Object.keys(options).filter((k) => !IN_TURN_OPTIONS.includes(k));
          if (unknown.length > 0) {
            throw new Error(`${name}: capture waitInTurn has no option ${unknown.map((k) => JSON.stringify(k)).join(", ")} (it takes ${IN_TURN_OPTIONS.join(", ")}; it has no deadline of its own: it ends on a cut-off, a request with no answer for unansweredMs, or a page idle for idleMs)`);
          }
          const { since = 0, settled = true, unansweredMs, idleMs = IN_TURN_IDLE_MS, what = "waitInTurn" } = options;
          if (!Number.isInteger(since) || since < 0) throw new Error(`${name}: capture waitInTurn since is a mark() (a seq), got ${showValue(since)}`);
          if (typeof settled !== "boolean") throw new Error(`${name}: capture waitInTurn settled is true (once the row has settled) or false (once it is sent), got ${showValue(settled)}`);
          if (unansweredMs !== undefined) positiveMs(name, "unansweredMs", unansweredMs, "how long a request may go unanswered before the stack is said not to have answered it");
          positiveMs(name, "idleMs", idleMs, "how long a page with none of its requests in flight may change nothing");
          if (typeof what !== "string" || what.trim() === "") throw new Error(`${name}: capture waitInTurn what is a non-empty string naming the wait, got ${showValue(what)}`);
          return waitInTurn(test, { since, settled, unansweredMs, idleMs, what });
        },
      },
      stop: {
        value: () => {
          stopped = true;
          if (live.size === 0) detach();
          return rows;
        },
      },
    });
    return rows;
  }

  /**
   * Hold this user's own requests to `path` on one of the stack's origins,
   * one rule per request in the order they reach the route (see A SLOW OR
   * FAILING NETWORK in the header), and then let each go on with
   * route.fallback(), to the tripwire and on to the stack. `rules[i]` is for
   * the i-th matching request: a number holds it that many ms, a function
   * holds it until the promise it returns settles (it is called as the
   * request arrives; a rejection or a throw releases it too, noted as
   * `ruleError`), null lets it go at once. Requests past the list go at once.
   * No request is held longer than `maxMs`.
   *
   * `at` is the origin: "hosting" (the default) the app's, target.origin;
   * "firestore" the stack's Firestore, where the page's Firestore SDK sends
   * its requests (FIRESTORE_LISTEN_PATH is its Listen channel). Anything
   * else, or a target without a Firestore URL, throws before any route.
   * `path` is an exact pathname ("/draft" is POST /draft, never the frame's
   * GET /draft/<doc>/<file>) or a RegExp over it; `method` POST by default,
   * a list, or null for any; `match({method, url, path, postJson, postData})`
   * narrows it further (a throw is a non-match), and only matching requests
   * take a rule. Registered after the tripwire, so it is consulted first.
   *
   * Resolves once the route is in place, {rows, seen(), restore()}: `rows`
   * (live) one per matching request, `{seq, t, method, url, path, postJson,
   * rule: "ms"|"until"|"none", ms, heldAt, releasedAt, released, ruleError}`,
   * where `heldAt`/`releasedAt` are this process's performance.now() as it
   * reached the route and as it went on, and `released` why it went on:
   * "rule", "cap" (maxMs), "restore", "at-once" (no rule), or null while
   * still held. `seen()` is rows.length. `restore()` takes no more requests,
   * lets every one still held go now, removes the route and resolves the
   * rows: call it in a finally. Bodies are in memory unredacted: write rows
   * only through ctx.ev.
   */
  async delayRequests(path, { method = "POST", rules, match = null, maxMs = DELAY_MAX_MS, at = "hosting" } = {}) {
    const what = "delayRequests";
    const take = requestRoute(this, what, path, method, match, at);
    if (!Array.isArray(rules) || !rules.every((r) => r === null || typeof r === "function" || (typeof r === "number" && Number.isFinite(r) && r >= 0))) {
      throw new Error(`${this.name}: ${what} rules is a list of ms (a number), a function returning a promise, or null, one per request, got ${showValue(rules)}`);
    }
    if (!(typeof maxMs === "number" && Number.isFinite(maxMs) && maxMs > 0)) throw new Error(`${this.name}: ${what} maxMs is a positive number of ms, got ${showValue(maxMs)}`);
    const plan = [...rules];
    const rows = [];
    const waiting = new Set();
    let restored = false;
    const handler = async (route) => {
      const req = route.request();
      const base = restored ? null : take.take(req);
      if (!base) return route.fallback().catch(() => undefined);
      const rule = rows.length < plan.length ? plan[rows.length] : null;
      const row = {
        seq: rows.length,
        t: now(),
        ...base,
        rule: rule === null ? "none" : typeof rule === "function" ? "until" : "ms",
        ms: typeof rule === "number" ? rule : null,
        heldAt: performance.now(),
        releasedAt: null,
        released: null,
        ruleError: null,
      };
      rows.push(row);
      if (rule === null) {
        row.released = "at-once";
      } else {
        await new Promise((resolve) => {
          const w = { done: false, timer: null, cap: null };
          w.go = (why) => {
            if (w.done) return;
            w.done = true;
            clearTimeout(w.timer);
            clearTimeout(w.cap);
            waiting.delete(w);
            row.released = why;
            resolve();
          };
          waiting.add(w);
          w.cap = setTimeout(() => w.go("cap"), maxMs);
          if (typeof rule === "number") {
            w.timer = setTimeout(() => w.go("rule"), rule);
          } else {
            Promise.resolve()
              .then(() => rule())
              .then(
                () => w.go("rule"),
                (err) => {
                  row.ruleError = String(err?.message ?? err);
                  w.go("rule");
                },
              );
          }
        });
      }
      row.releasedAt = performance.now();
      return route.fallback().catch(() => undefined);
    };
    await this.context.route(take.url, handler);
    return {
      rows,
      seen: () => rows.length,
      restore: async () => {
        restored = true;
        for (const w of [...waiting]) w.go("restore");
        await this.context.unroute(take.url, handler).catch(() => undefined);
        return rows;
      },
    };
  }

  /**
   * Answer this user's own requests to `path` on one of the stack's origins
   * here, as failures, so the stack never sees them (see A SLOW OR FAILING
   * NETWORK in the header): `status` an HTTP status from 400 to 599 (500 by
   * default) with `body` (by default FAIL_BODY as JSON; a string is sent as
   * given, as text/plain; anything else as JSON), or "abort", the browser's
   * own network failure (route.abort("failed"): fetch rejects). `count`
   * fails only the next so many and lets the rest through; null (the
   * default) fails every one until restore(). `path`, `method`, `match` and
   * `at` choose requests as for delayRequests, and only on that one origin
   * of the stack, so a breach is never answered here.
   *
   * Resolves once the route is in place, {failed, restore()}: `failed`
   * (live) one row per failed request, `{seq, t, at, method, url, path,
   * postJson, status}` (`at` this process's performance.now(), `status` what
   * it was answered, or "abort"); `restore()` removes the route and resolves
   * `failed`: call it in a finally.
   */
  async failRequests(path, { method = "POST", status = 500, count = null, match = null, body = undefined, at = "hosting" } = {}) {
    const what = "failRequests";
    const take = requestRoute(this, what, path, method, match, at);
    if (!(status === "abort" || (Number.isInteger(status) && status >= 400 && status <= 599))) {
      throw new Error(`${this.name}: ${what} status is an HTTP status from 400 to 599, or "abort", got ${showValue(status)}`);
    }
    if (!(count === null || (Number.isInteger(count) && count > 0))) throw new Error(`${this.name}: ${what} count is a positive integer, or null for every request until restore(), got ${showValue(count)}`);
    if (status === "abort" && body !== undefined) throw new Error(`${this.name}: ${what} an aborted request has no body: drop body, or give an HTTP status`);
    let answer = null;
    if (status !== "abort") {
      if (body === undefined) answer = { contentType: "application/json", body: JSON.stringify(FAIL_BODY) };
      else if (typeof body === "string") answer = { contentType: "text/plain; charset=utf-8", body };
      else {
        const json = JSON.stringify(body);
        if (json === undefined) throw new Error(`${this.name}: ${what} body is a string or JSON, got ${typeof body}`);
        answer = { contentType: "application/json", body: json };
      }
    }
    const failed = [];
    let restored = false;
    const handler = async (route) => {
      const req = route.request();
      const base = restored || (count !== null && failed.length >= count) ? null : take.take(req);
      if (!base) return route.fallback().catch(() => undefined);
      failed.push({ seq: failed.length, t: now(), at: performance.now(), ...base, status });
      if (status === "abort") return route.abort("failed").catch(() => undefined);
      return route.fulfill({ status, contentType: answer.contentType, body: answer.body }).catch(() => undefined);
    };
    await this.context.route(take.url, handler);
    return {
      failed,
      restore: async () => {
        restored = true;
        await this.context.unroute(take.url, handler).catch(() => undefined);
        return failed;
      },
    };
  }

  /**
   * Record the editor's save state and the document frame's input events on
   * the page's own clock (see THE SAVE STATE, ON THE PAGE'S CLOCK in the
   * header), from now until stop() or a navigation of the page. Arm it before
   * the action; it may be armed before Edit (the toolbar's appearance is a
   * row, and the edit frame is listened to as it loads).
   *
   * Resolves {states, inputs, armedAt, read(), stop()}. `states` (live) is
   * one row per change, `{i, s, t, text}`: `s` the data-state ("idle",
   * "dirty", "saving", "saved", "error"; null while no save state shows),
   * `text` what it says (trimmed, 200 characters), `t` the page's clock. The
   * first row is the state at arming, and a row is kept only when `s` or
   * `text` differs from the last one, so `states.map((r) => r.s)` is the
   * sequence of transitions. `inputs` (live) is the time of each input event
   * in any frame document reached, in order. `armedAt` is the page's clock at
   * arming. Times are ms on the page's clock: `performance.timeOrigin +
   * performance.now()`, monotonic within the page and, on one machine, within
   * a few ms of the page's Date.now(). Compare them with each other, never
   * with this process's clock.
   *
   * `read()` resolves `{armed, armedAt, states, inputs, docs}` as plain
   * copies, taken from the page itself (which also brings the live arrays up
   * to date); `armed: false` after a navigation, with the rows that reached
   * Node. `docs` is how many frame documents were listened to. `stop()` ends
   * the recording in the page and resolves the same, final.
   */
  async recordSaveStates() {
    const page = this.page;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const binding = `__e2eSaveStates_${id}`;
    const states = [];
    const inputs = [];
    let docs = 0;
    let stopped = false;
    let final = null;
    await page.exposeBinding(binding, (_source, msg) => {
      if (stopped || !msg || !Number.isInteger(msg.i ?? msg.docs)) return;
      if (msg.type === "state") states[msg.i] = { i: msg.i, s: msg.s, t: msg.t, text: msg.text };
      else if (msg.type === "input") inputs[msg.i] = msg.t;
      else if (msg.type === "doc") docs = Math.max(docs, msg.docs);
    });
    const armed = await page.evaluate(saveStateRecorder, { key: SAVE_STATES_KEY, id, binding, frame: DOC_FRAME });
    const take = (snap) => {
      states.splice(0, states.length, ...snap.states);
      inputs.splice(0, inputs.length, ...snap.inputs);
      docs = snap.docs;
    };
    const copy = (armedFlag) => ({ armed: armedFlag, armedAt: armed.armedAt, states: states.filter(Boolean).map((r) => ({ ...r })), inputs: inputs.filter((t) => t !== undefined), docs });
    const fromPage = async (op) => {
      if (page.isClosed()) return null;
      return page.evaluate(({ key, id, op }) => window[Symbol.for(key)]?.get(id)?.[op]?.() ?? null, { key: SAVE_STATES_KEY, id, op }).catch(() => null);
    };
    return {
      states,
      inputs,
      armedAt: armed.armedAt,
      read: async () => {
        if (final) return { ...final, states: final.states.map((r) => ({ ...r })), inputs: [...final.inputs] };
        const snap = await fromPage("snapshot");
        if (snap) take(snap);
        return copy(Boolean(snap));
      },
      stop: async () => {
        if (!final) {
          const snap = await fromPage("stop");
          stopped = true;
          if (snap) take(snap);
          final = copy(Boolean(snap));
        }
        return { ...final, states: final.states.map((r) => ({ ...r })), inputs: [...final.inputs] };
      },
    };
  }

  /**
   * Resolves `log.created` once every creation this user's pages have been
   * answered so far is read and ledgered (see WHAT A PAGE CREATED in the
   * header): call it after the page shows what it made. Throws when one is
   * still being read after `timeout`.
   */
  async settleCreated({ timeout = 30_000 } = {}) {
    const pending = [...this.creating];
    if (pending.length > 0) {
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${this.name}: settleCreated: ${this.creating.size} creation(s) still being read after ${timeout} ms`)), timeout);
      });
      try {
        await Promise.race([Promise.allSettled(pending), late]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.log.created;
  }

  /**
   * Drop `files` on an element, as the browser builds a drop from the desktop
   * (see DROPPED FILES in the header): a DataTransfer holding real File
   * objects, its `types` "Files", dispatched as each of `events` in order
   * (dragenter, dragover, drop by default; DROP_EVENT_TYPES lists what may be
   * given) at the element's centre. `selector` is a selector on the page
   * (its first match, waited for up to `timeout`) or a Playwright Locator.
   * `files` is a non-empty list of `{name, data, type}`, where `data` is a
   * Buffer, a Uint8Array or a string (sent as UTF-8) and `type` the MIME type
   * ("" when the browser would not know it); Playwright's `{name, buffer,
   * mimeType}` is taken too. Resolves one `{type, claimed}` per event:
   * `claimed` is whether the page called preventDefault on it.
   */
  async dropFiles(selector, files, { events = DROP_EVENTS, timeout = 10_000 } = {}) {
    const what = `${this.name}: dropFiles`;
    const isLocator = selector !== null && typeof selector === "object" && typeof selector.evaluate === "function";
    if (!isLocator && (typeof selector !== "string" || selector.trim() === "")) throw new TypeError(`${what}: selector is a selector on the page or a Playwright Locator, got ${showValue(selector)}`);
    if (!Array.isArray(files) || files.length === 0) throw new TypeError(`${what}: files is a non-empty list of {name, data, type}, got ${showValue(files)}`);
    const payload = files.map((f, i) => {
      const name = f?.name;
      const data = f?.data ?? f?.buffer;
      const type = f?.type ?? f?.mimeType ?? "";
      if (typeof name !== "string" || name === "") throw new TypeError(`${what}: files[${i}].name is the file's name, got ${showValue(name)}`);
      if (!(typeof data === "string" || data instanceof Uint8Array)) throw new TypeError(`${what}: files[${i}].data is a Buffer, a Uint8Array or a string, got ${data === null ? "null" : typeof data}`);
      if (typeof type !== "string") throw new TypeError(`${what}: files[${i}].type is a MIME type string ("" for none), got ${showValue(type)}`);
      return { name, type, b64: (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength)).toString("base64") };
    });
    if (!Array.isArray(events) || events.length === 0 || !events.every((e) => DROP_EVENT_TYPES.includes(e))) {
      throw new TypeError(`${what}: events is a non-empty list of ${DROP_EVENT_TYPES.join(", ")}, got ${showValue(events)}`);
    }
    const locator = isLocator ? selector : this.page.locator(selector).first();
    return locator.evaluate(dispatchDrop, { payload, events: [...events] }, { timeout });
  }

  /**
   * Run `action` (an async function: the click that raises it) and answer the
   * window.alert, confirm, prompt or beforeunload dialog it raises: accepted
   * (with `value` typed into a prompt) or, with `accept: false`, dismissed.
   * Only the first dialog is answered; one after it is Playwright's, which
   * dismisses it. A prompt accepted with no `value` returns "" to the page,
   * not its default: pass the default as `value` to accept it as offered.
   * Resolves `{type, message, defaultValue, accepted, value}`
   * once both the dialog is answered and `action` has settled. Throws when
   * `action` throws, or when no dialog came within `timeout` of the call.
   */
  async answerDialog(action, { accept = true, value, timeout = 15_000 } = {}) {
    const what = `${this.name}: answerDialog`;
    if (typeof action !== "function") throw new TypeError(`${what}: action is a function that raises the dialog, got ${typeof action}`);
    if (typeof accept !== "boolean") throw new TypeError(`${what}: accept is true or false, got ${showValue(accept)}`);
    if (value !== undefined && typeof value !== "string") throw new TypeError(`${what}: value is the text typed into a prompt, got ${showValue(value)}`);
    if (value !== undefined && !accept) throw new TypeError(`${what}: a value is typed only into a prompt that is accepted`);
    const page = this.page;
    let done = false;
    let answered;
    const seen = new Promise((resolve, reject) => {
      answered = { resolve, reject };
    });
    const onDialog = async (dialog) => {
      if (done) return;
      done = true;
      page.off("dialog", onDialog);
      const info = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), accepted: accept, value: accept && dialog.type() === "prompt" ? (value ?? "") : null };
      try {
        if (accept) await dialog.accept(value);
        else await dialog.dismiss();
        answered.resolve(info);
      } catch (err) {
        answered.reject(err);
      }
    };
    page.on("dialog", onDialog);
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no dialog within ${timeout} ms`)), timeout);
    });
    try {
      const [info] = await Promise.all([Promise.race([seen, late]), action()]);
      return info;
    } finally {
      clearTimeout(timer);
      done = true;
      page.off("dialog", onDialog);
    }
  }

  /**
   * Press Dismiss on every toast showing that has one (see DIALOGS, TOASTS in
   * the header): a DOM click on each toast's own button, so one lying under
   * another is dismissed too, then wait up to `timeout` for each to be gone.
   * A busy toast and one whose button is an action ("Undo") have no Dismiss
   * and are left. Resolves `{dismissed, left}`, each `[{kind, text}]` with
   * `kind` "error", "info" or "busy". Throws when a pressed toast is still
   * there after `timeout`.
   */
  async dismissToasts({ timeout = 10_000 } = {}) {
    const page = this.page;
    const seen = await page.evaluate(
      ({ key, label }) => {
        const pressed = [];
        const out = { dismissed: [], left: [] };
        for (const el of document.querySelectorAll(".toast-stack .toast")) {
          const span = Array.from(el.children).find((c) => c.tagName === "SPAN" && !c.classList.contains("spinner"));
          const row = { kind: el.classList.contains("toast-error") ? "error" : el.classList.contains("toast-busy") ? "busy" : "info", text: (span?.textContent ?? el.textContent ?? "").trim() };
          const button = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label);
          if (!button) {
            out.left.push(row);
            continue;
          }
          button.click();
          pressed.push(el);
          out.dismissed.push(row);
        }
        window[Symbol.for(key)] = pressed;
        return out;
      },
      { key: DISMISSED_KEY, label: TOAST_DISMISS_LABEL },
    );
    const deadline = now() + timeout;
    for (;;) {
      const still = await page.evaluate((key) => (window[Symbol.for(key)] ?? []).filter((el) => el.isConnected).length, DISMISSED_KEY);
      if (still === 0) break;
      if (now() >= deadline) throw new Error(`${this.name}: dismissToasts: ${still} of ${seen.dismissed.length} pressed toast(s) still showing after ${timeout} ms`);
      await sleep(50);
    }
    await page.evaluate((key) => delete window[Symbol.for(key)], DISMISSED_KEY).catch(() => undefined);
    return seen;
  }

  async goto(path, { waitUntil = "load", timeout = 30_000 } = {}) {
    return this.page.goto(this.url(path), { waitUntil, timeout });
  }

  /** Toasts since a mark (an index into the toast log). */
  toastMark() {
    return this.log.toasts.length;
  }

  /**
   * The toasts this user's pages showed since a toastMark(), oldest first:
   * `log.toasts` from the mark, less any other tab's (ownsPage; with no tab,
   * all of them). Each toast names its page in a non-enumerable `page`.
   */
  toastsSince(since = 0) {
    return ownToasts(this, since);
  }

  async waitForToast(pred, { since = 0, timeout = 30_000 } = {}) {
    const test = typeof pred === "function" ? pred : (t) => (pred instanceof RegExp ? pred.test(t.text) : t.text.includes(pred));
    const deadline = now() + timeout;
    while (now() < deadline) {
      const hit = ownToasts(this, since).find((t) => t.kind !== "busy" && test(t));
      if (hit) return hit;
      await sleep(50);
    }
    const seen = ownToasts(this, since).map((t) => `${t.kind}: ${t.text}`).join(" | ") || "none";
    throw new Error(`${this.name}: no matching toast within ${timeout} ms (seen: ${seen})`);
  }

  /** Poll `fn` in Node until it returns a truthy value. */
  async poll(fn, { timeout = 30_000, interval = 100, what = "condition" } = {}) {
    const deadline = now() + timeout;
    let last;
    while (now() < deadline) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (err) {
        last = err;
      }
      await sleep(interval);
    }
    throw new Error(`${this.name}: ${what} not reached within ${timeout} ms${last ? ` (last error: ${last.message.split("\n")[0]})` : ""}`);
  }

  /**
   * Wait up to `timeout` for `locator` (a Playwright locator, or a selector,
   * whose first match is waited for) to be visible: what the page shows,
   * which on a loaded shared stack can wait on a stalled Listen channel or on
   * a function Hosting cut off. When the wait runs out and THIS page saw the
   * stack stall in that load (lib/test.mjs stallEvidence: a response answered
   * Hosting's cut-off 504, or the page's Firestore client losing the
   * emulator; read from 10 s before the first wait, and for a load it made
   * itself from when that load began), `path` is loaded again (goto, the
   * same `timeout`) and the wait made again, up to `reloads` (1) times. A page
   * that saw no stall is not loaded again: its wait's failure is the case's.
   *
   * Resolves {loads, stall}: how many loads it took (1 when the first
   * showed), and the evidence that led to the last reload (null when none).
   * When it does not show, it throws E2E_NOT_SHOWN, "<user>: <what> not shown
   * within <timeout> ms of load <n> of <path>: the page saw the stack stall
   * in that load (…)" or "…: the page saw no stall of the stack in that
   * load", with `loads`, `stall` (that load's evidence, [] for none) and the
   * Playwright timeout as `cause`. Its "within <timeout> ms" is the LAST
   * load's wait, so pageStall (inconclusiveOnPageStall) judges that load,
   * with its usual 10 s margin before it, never the whole of both: a page
   * loaded again after a stall, that still does not show on a stack that
   * answered it, FAILS. `what` names it (default the selector, or
   * "the locator"); `path` null makes no reload. Any other failure of the
   * wait (a closed page) throws as Playwright threw it.
   */
  async waitShown(locator, { what = null, path = null, timeout = 30_000, reloads = 1 } = {}) {
    const loc = typeof locator === "string" ? this.page.locator(locator).first() : locator;
    if (!loc || typeof loc.waitFor !== "function") throw new Error(`${this.name}: waitShown takes a Playwright locator or a selector, got ${showValue(locator)}`);
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`${this.name}: waitShown timeout is a number of ms above 0, got ${showValue(timeout)}`);
    if (!Number.isInteger(reloads) || reloads < 0) throw new Error(`${this.name}: waitShown reloads is a whole number 0 or more, got ${showValue(reloads)}`);
    if (path !== null && (typeof path !== "string" || !path.startsWith("/"))) throw new Error(`${this.name}: waitShown path is the page to load again, a path from "/", or null, got ${showValue(path)}`);
    if (what !== null && (typeof what !== "string" || what.trim() === "")) throw new Error(`${this.name}: waitShown what names what is waited for, or null, got ${showValue(what)}`);
    const label = what ?? (typeof locator === "string" ? locator : "the locator");
    const { stallEvidence } = await import("./test.mjs");
    let loads = 1;
    let stall = null;
    let reloadedAt = null; // when the load waitShown made itself began: what the page saw before it was the last load's
    for (;;) {
      const started = now();
      const failed = await loc.waitFor({ state: "visible", timeout }).then(() => null, (e) => e);
      if (failed === null) return { loads, stall };
      if (!(failed?.name === "TimeoutError" || /\bTimeout \d+ ?ms exceeded\b/.test(String(failed?.message)))) throw failed;
      const seen = stallEvidence([this], reloadedAt ?? started - WAIT_SHOWN_MARGIN_MS);
      const evidence = [...seen.cut, ...seen.lost];
      if (evidence.length > 0 && path !== null && loads <= reloads) {
        stall = evidence;
        loads += 1;
        reloadedAt = now();
        await this.goto(path, { timeout });
        continue;
      }
      const why = evidence.length > 0 ? `the page saw the stack stall in that load (${evidence.slice(0, 3).join("; ")}${evidence.length > 3 ? `; and ${evidence.length - 3} more` : ""})` : "the page saw no stall of the stack in that load";
      const before = loads > 1 ? `; loaded again after the stack stalled (${stall.slice(0, 2).join("; ")})` : "";
      const err = new Error(`${this.name}: ${label} not shown within ${timeout} ms of load ${loads}${path ? ` of ${path}` : ""}: ${why}${before}`, { cause: failed });
      err.code = "E2E_NOT_SHOWN";
      err.loads = loads;
      err.stall = evidence;
      throw err;
    }
  }

  /**
   * waitShown for a VALUE the page shows rather than a locator: a chip's
   * state, a count, a label read from the page, which on a loaded shared
   * stack is often fed by a Listen channel that stalled. `read(page)` (async,
   * called with this user's page) is polled every `interval` ms for up to
   * `timeout` until its value is `want` (isDeepStrictEqual), or passes it
   * when `want` is a function (value) => boolean. A read that throws, or that
   * has not answered when the wait's time runs out, counts as "not yet".
   *
   * When the wait runs out and THIS page saw the stack stall in its current
   * load (lib/test.mjs stallEvidence: a response answered Hosting's cut-off
   * 504, or its Firestore client losing the emulator), `path` is loaded
   * again (goto, the same `timeout`) and the value waited for again, up to
   * `reloads` (1) times. Unlike waitShown, the evidence is read from when
   * the page's current document began loading (its `performance.timeOrigin`)
   * or 10 s before the first wait, whichever is earlier: a listener the
   * stack stalled minutes ago delivers nothing now, and says so only once.
   * For a load waitValue made itself, from when that load began. A page that
   * saw no stall is not loaded again: its wait's failure is the case's.
   *
   * Resolves {loads, stall, value}: the loads it took (1 when the first
   * showed it), the evidence behind the last reload (null when none), and
   * the value read. When it does not show, it throws E2E_NOT_SHOWN, "<user>:
   * <what> not shown within <timeout> ms of load <n> of <path> (want <want>,
   * last read <value>): the page saw the stack stall in that load (…)" or
   * "…: the page saw no stall of the stack in that load", with `loads`,
   * `stall` (that load's evidence, [] for none), `value` (the last value
   * read, undefined when none was) and `want`; the last read's error is its
   * `cause`. Its "within <timeout> ms" is the LAST load's wait, so pageStall
   * judges that load alone, as with waitShown. `what` names it (default "the
   * value"); `path` null makes no reload. A closed page throws at once.
   */
  async waitValue(read, want, { what = null, path = null, timeout = 30_000, reloads = 1, interval = 200 } = {}) {
    if (typeof read !== "function") throw new Error(`${this.name}: waitValue reads the value with an async (page) => value, got ${showValue(read)}`);
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`${this.name}: waitValue timeout is a number of ms above 0, got ${showValue(timeout)}`);
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) throw new Error(`${this.name}: waitValue interval is a number of ms above 0, got ${showValue(interval)}`);
    if (!Number.isInteger(reloads) || reloads < 0) throw new Error(`${this.name}: waitValue reloads is a whole number 0 or more, got ${showValue(reloads)}`);
    if (path !== null && (typeof path !== "string" || !path.startsWith("/"))) throw new Error(`${this.name}: waitValue path is the page to load again, a path from "/", or null, got ${showValue(path)}`);
    if (what !== null && (typeof what !== "string" || what.trim() === "")) throw new Error(`${this.name}: waitValue what names what is waited for, or null, got ${showValue(what)}`);
    const label = what ?? "the value";
    const matches = typeof want === "function" ? (v) => Boolean(want(v)) : (v) => isDeepStrictEqual(v, want);
    const wanted = typeof want === "function" ? `a value ${want.name ? `${want.name} passes` : "the predicate passes"}` : clipValue(want);
    const { stallEvidence } = await import("./test.mjs");
    let loads = 1;
    let stall = null;
    let reloadedAt = null; // when the load waitValue made itself began: what the page saw before it was the last load's
    let value;
    let readAny = false;
    let lastError = null;
    for (;;) {
      const started = now();
      const deadline = started + timeout;
      for (;;) {
        if (this.page.isClosed()) throw lastError ?? new Error(`${this.name}: waitValue: the page is closed`);
        const got = await settleBy(() => read(this.page), Math.max(deadline, now() + WAIT_VALUE_READ_MIN_MS));
        if (!got.done) {
          lastError = new Error("the read had not answered when the wait's time ran out");
        } else {
          lastError = got.error;
          if (!got.error) {
            value = got.value;
            readAny = true;
            try {
              if (matches(value)) return { loads, stall, value };
            } catch (e) {
              lastError = e;
            }
          }
        }
        const left = deadline - now();
        if (left <= 0) break;
        await sleep(Math.min(interval, left));
      }
      const loadBegan = reloadedAt === null ? await documentBegan(this.page) : null;
      const since = reloadedAt ?? Math.min(loadBegan ?? Infinity, started - WAIT_SHOWN_MARGIN_MS);
      const seen = stallEvidence([this], since);
      const evidence = [...seen.cut, ...seen.lost];
      if (evidence.length > 0 && path !== null && loads <= reloads) {
        stall = evidence;
        loads += 1;
        reloadedAt = now();
        await this.goto(path, { timeout });
        continue;
      }
      const why = evidence.length > 0 ? `the page saw the stack stall in that load (${evidence.slice(0, 3).join("; ")}${evidence.length > 3 ? `; and ${evidence.length - 3} more` : ""})` : "the page saw no stall of the stack in that load";
      const before = loads > 1 ? `; loaded again after the stack stalled (${stall.slice(0, 2).join("; ")})` : "";
      const lastRead = readAny ? `last read ${clipValue(value)}` : `nothing read${lastError ? ` (${String(lastError?.message ?? lastError).split("\n")[0].slice(0, 120)})` : ""}`;
      const err = new Error(`${this.name}: ${label} not shown within ${timeout} ms of load ${loads}${path ? ` of ${path}` : ""} (want ${wanted}, ${lastRead}): ${why}${before}`, lastError ? { cause: lastError } : undefined);
      err.code = "E2E_NOT_SHOWN";
      err.loads = loads;
      err.stall = evidence;
      err.value = readAny ? value : undefined;
      err.want = want;
      throw err;
    }
  }

  /**
   * Sign in with an address and password at the sign-in page, and report what
   * POST /session answered (SPEC §2, §3, §14).
   *
   * `path` is the sign-in page with whatever query the case needs, such as
   * `/signup?next=<encoded>`; another page throws. `expectStatus` is the
   * outcome the case wants: "ok" (the default), "unverified", "not_allowed",
   * "session_failed", a list of them, or null for whichever comes. Another
   * outcome throws "POST /session answered <http> <body> (wanted …)", with
   * that answer as the error's `response` ({method, path, status, ms}), so
   * Hosting's cut-off 504 is the stack not answering (lib/test.mjs).
   *
   * It resolves once the page shows the outcome: for "ok" the app has left
   * the sign-in page and the __session cookie is stored; for "unverified" the
   * verification gate shows (`gate` "needs_verification", or "needs_email");
   * for "not_allowed" its notice; for "session_failed" the form again, with
   * its error. When the context is already signed in to Firebase, no form
   * appears: the page's own POST /session is the answer, `already` is true,
   * and "ok" means the page redirected.
   *
   * `here: true` signs in on the sign-in page the app itself navigated to,
   * opening nothing: the page is not reloaded, so the URL the app built (its
   * `?next=`, a Fork intent, a link key) and its in-memory state are the
   * ones signed in on. It waits up to `timeout` for the page to be the
   * sign-in page on the stack's origin showing the form (or a gate, which is
   * then `already`, answered by the last POST /session this user saw), so it
   * may be called straight after the click that leads there. A page that
   * never gets there throws, naming the pathname it is on. `here` with a
   * `path` throws: one opens a page, the other refuses to.
   *
   * `next` is where the app should take the user once signed in, such as
   * `/d/<docId>`: it opens `/signup?next=<encoded next>` (so the app boots
   * once, on the sign-in page, and goes on to the document itself) and, when
   * the outcome is "ok", resolves only once the page is at `next` (its
   * pathname and query, as the URL parser normalises them). One that does
   * not get there within `timeout` throws `signInUi({next}): signed in, but
   * the app did not land on <pathname> …; the page is at <pathname>` (the
   * pathnames only: a query may hold a link key). Only a path the app
   * honours is taken (app/src/next.ts safeNext): any other throws before
   * anything opens; probe the app's refusal of one with `path` instead.
   * `next` with `path` or `here` throws. A `next` the app goes on from by
   * itself (Fork's `&fork=1`) is left before it can be seen: use `path`.
   *
   * @returns {Promise<{status, already, httpStatus, body, gate, url, bodyUnread?}>}
   *   `status` the outcome, `httpStatus` the response's status (null when
   *   already signed in and none was seen), `body` its JSON or null, `url` the
   *   page's URL at the end; `bodyUnread: true` when the body could not be
   *   read (the outcome then comes from the page).
   *
   * `timeout` bounds each wait (the page, POST /session's answer, the page
   * showing the outcome, landing on `next`). Its default, 75 s
   * (SIGN_IN_TIMEOUT_MS), outlasts Hosting's 60 s cut-off.
   */
  async signInUi(email, password, { timeout = SIGN_IN_TIMEOUT_MS, path, next, expectStatus = "ok", here = false } = {}) {
    if (here !== true && here !== false) throw new Error(`signInUi: here is true or false, got ${JSON.stringify(here)}`);
    if (here && path !== undefined) {
      throw new Error(`signInUi: here signs in on the sign-in page the app already opened, and path names one to open: give one or the other (path ${JSON.stringify(path)})`);
    }
    let landing = null;
    if (next !== undefined) {
      if (here) throw new Error("signInUi: next names a sign-in page to open, and here signs in on the one the app already opened: give one or the other");
      if (path !== undefined) throw new Error(`signInUi: next builds the sign-in page's path (/signup?next=…): give next or path, not both (path ${JSON.stringify(path)})`);
      landing = signInNext(this.target.origin, next);
      path = `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
    }
    // Once "ok": the page at `next`, or a throw naming where it is instead.
    const land = async () => {
      if (!landing) return;
      await this.poll(() => pathAndSearch(this.page.url()) === landing.want, { timeout, interval: 50, what: `landing on ${landing.pathname}` }).catch((err) => {
        throw new Error(`${this.name}: signInUi({next}): signed in, but the app did not land on ${landing.pathname} within ${timeout} ms; the page is at ${pathnameOf(this.page.url())}`, { cause: err });
      });
    };
    const signPath = here ? SIGN_IN_PATH : signInPathname(this.target.origin, path === undefined ? SIGN_IN_PATH : path);
    const want = sessionExpectation(expectStatus);
    const wanted = want ? ` (wanted ${[...want].join(" or ")})` : "";
    this.email = email;
    // Here, the page loaded before this call: whatever POST /session it made
    // is the last one this user saw, so the "already" answer is looked up from
    // the start of the log.
    const loadMark = here ? 0 : this.responseMark();
    let first;
    if (here) {
      const origin = new URL(this.target.origin).origin;
      const pathname = () => {
        try {
          return new URL(this.page.url()).pathname;
        } catch {
          return String(this.page.url());
        }
      };
      first = await this.poll(
        async () => {
          let at = null;
          try {
            at = new URL(this.page.url()).origin;
          } catch {}
          if (at !== origin) return null;
          const s = await this.page.evaluate(signInPageState, signPath);
          // "left" is the app not there yet (or gone): only the page itself counts.
          return s && s.state !== "left" ? s : null;
        },
        { timeout, what: "the sign-in page" },
      ).catch((err) => {
        // The pathname only: the query may carry a link key inside ?next=.
        throw new Error(`${this.name}: signInUi({here: true}): the app did not show the sign-in page (${SIGN_IN_PATH}, its form or a gate) within ${timeout} ms; the page is at ${pathname()}`, { cause: err });
      });
    } else {
      await this.goto(path === undefined ? SIGN_IN_PATH : path);
      first = await this.poll(() => this.page.evaluate(signInPageState, signPath), {
        timeout,
        what: "the sign-in form, a redirect or a sign-in gate",
      });
    }
    if (first.state !== "form") {
      // Already signed in to Firebase: the app posted /session as it loaded.
      const status = SIGN_IN_OUTCOME[first.state];
      const seen = await this.waitForResponse(SESSION_POST, { since: loadMark, timeout: 2_000 }).catch(() => null);
      const loaded = seen ? this.findResponses(SESSION_POST, { since: loadMark }).at(-1) : null;
      const body = await responseJson(loaded?.response);
      if (want && !want.has(status)) {
        // With `next`, its pathname only: its query may hold a link key, which no redaction finds once encoded.
        const where = here ? "the sign-in page the app opened" : landing ? `${SIGN_IN_PATH}?next=${landing.pathname}` : path === undefined ? SIGN_IN_PATH : path;
        throw refusing(`${this.name}: already signed in at ${where}: the page shows "${status}", POST /session answered ${loaded?.status ?? "(none seen)"} ${JSON.stringify(body)}${wanted}`, loaded);
      }
      if (status === "ok") await land();
      return { status, already: true, httpStatus: loaded?.status ?? null, body, gate: signInGate(first), url: this.page.url() };
    }
    await this.page.fill("#auth-email", email);
    await this.page.fill("#auth-password", password);
    const mark = this.responseMark();
    await this.page.getByRole("button", { name: "Sign in", exact: true }).click();
    const res = await this.waitForResponse(SESSION_POST, { since: mark, timeout });
    // The typed outcome, when the body can still be read. A page that
    // navigates by reloading as soon as it has read it leaves Playwright
    // nothing to read; then the status, the page and the cookie decide.
    const body = await responseJson(res.response);
    const said = typeof body?.status === "string" ? body.status : null;
    const refuse = (status) => (want && !want.has(status)) || (status === "ok" && res.status !== 200);
    if (said !== null && refuse(said)) throw refusing(`${this.name}: POST /session answered ${res.status} ${JSON.stringify(body)}${wanted}`, res);
    const settleOn = said === null ? null : (SETTLES_ON[said] ?? "form");
    const settled = await this.poll(
      async () => {
        const s = await this.page.evaluate(signInPageState, signPath);
        if (!s) return null;
        // The form is back only with the error the failed session put there.
        if (s.state === "form" && !s.error) return null;
        return settleOn === null || s.state === settleOn ? s : null;
      },
      { timeout, what: said === null ? "the page to show the sign-in outcome" : `the page to show "${said}"` },
    );
    const status = said ?? SIGN_IN_OUTCOME[settled.state];
    if (said === null && refuse(status)) throw refusing(`${this.name}: POST /session answered ${res.status} (body unread), the page shows "${status}"${wanted}`, res);
    if (status === "ok" && !(await this.sessionCookie())) throw new Error(`${this.name}: signed in but no __session cookie was stored`);
    if (status === "ok") await land();
    return { status, already: false, httpStatus: res.status, body, gate: signInGate(settled), url: this.page.url(), ...(body ? {} : { bodyUnread: true }) };
  }

  /**
   * The `__session` cookie Chrome holds for the origin, or null. Read from the
   * UNFILTERED jar: Playwright's cookies(url) drops a Secure cookie for any
   * http host but `localhost`, and the stack's origin is http://127.0.0.1 —
   * where Chrome itself does store and send it (a loopback origin is secure).
   */
  async sessionCookie() {
    const host = new URL(this.target.origin).hostname;
    const all = await this.context.cookies();
    return all.find((c) => c.name === "__session" && (c.domain === host || c.domain === `.${host}`)) ?? null;
  }

  /** The document iframe as a Playwright Frame (re-queried: edit mode replaces the iframe). */
  async frame() {
    const f = await docFrame(this.page, DOC_FRAME);
    if (!f) throw new Error(`${this.name}: no ${DOC_FRAME} on ${this.page.url()}`);
    return f;
  }

  /** Wait for the viewer and a fully loaded document frame; `match` checks the frame's src. */
  async waitForFrame({ timeout = 45_000, match = null, editable = null } = {}) {
    return this.poll(
      async () => {
        const ready = await this.page.evaluate(
          ({ sel }) => {
            if (!document.querySelector(".viewer-body")) return null;
            if (document.querySelector(".frame-loading")) return null;
            const el = document.querySelector(sel);
            if (!el || !el.getAttribute("src")) return null;
            const d = el.contentDocument;
            if (!d || d.readyState !== "complete" || !d.body || d.location.href === "about:blank") return null;
            return { src: el.getAttribute("src"), sandbox: el.getAttribute("sandbox"), editable: d.body.getAttribute("contenteditable") };
          },
          { sel: DOC_FRAME },
        );
        if (!ready) return null;
        if (match && !match.test(ready.src)) return null;
        if (editable === true && ready.editable !== "true") return null;
        if (editable === false && ready.editable === "true") return null;
        return ready;
      },
      { timeout, what: `a loaded document frame${match ? ` matching ${match}` : ""}` },
    );
  }

  /**
   * Record every load of a document into this page's frames, from now until
   * `stop()` (see the header): one row per navigation request of a direct
   * child frame of the page to `docId`'s files, published or draft (any
   * document's when `docId` is null). A fragment change loads nothing and is
   * no row; a frame nested inside the document is not the reading frame and
   * is never recorded. Start it BEFORE the action whose loads you count.
   *
   * Returns {loads, summary(), settled(), stop()}. `loads` is live: each row
   * is {seq, frame (the Playwright Frame), frameIndex (1, 2, … per distinct
   * Frame: a remount is a new one), url, path, search, kind ("content" |
   * "draft"), t, pageMs (ms since this page's last navigation request, or
   * null when the watcher started after it), sandbox (the attribute's value,
   * null when it has none, undefined until read or when it could not be),
   * cls, status, committed, failure, redirects, unread (why not read)}.
   * `summary()` is the same as plain data, without `frame` and `url`.
   * `settled()` waits for the attribute reads in flight; `stop()` removes the
   * listeners and returns settled().
   */
  watchFrameLoads(docId = null) {
    const page = this.page;
    const main = page.mainFrame();
    const origin = new URL(this.target.origin).origin;
    const loads = [];
    const byRequest = new Map();
    const frameIndex = new Map();
    const pending = new Set();
    let pageStart = null;
    const strip = (u) => String(u).split("#")[0];
    const onRequest = (req) => {
      if (!req.isNavigationRequest()) return;
      const from = req.redirectedFrom();
      const chained = from ? byRequest.get(from) : null;
      if (chained) {
        // One load, however many hops: the row follows the chain to where it ends.
        byRequest.set(req, chained);
        chained.redirects += 1;
        chained.url = req.url();
        try {
          const u = new URL(req.url());
          chained.path = u.pathname;
          chained.search = u.search;
        } catch {}
        return;
      }
      let frame = null;
      try {
        frame = req.frame();
      } catch {
        frame = null;
      }
      if (frame === main) {
        if (!from) pageStart = now();
        return;
      }
      if (frame && frame.parentFrame() !== main) return;
      let url;
      try {
        url = new URL(req.url());
      } catch {
        return;
      }
      if (url.origin !== origin) return;
      const where = parseDocumentPath(url.pathname);
      if (!where || (docId != null && where.docId !== docId)) return;
      if (frame && !frameIndex.has(frame)) frameIndex.set(frame, frameIndex.size + 1);
      const t = now();
      const row = {
        seq: loads.length,
        frame,
        frameIndex: frame ? frameIndex.get(frame) : null,
        url: req.url(),
        path: url.pathname,
        search: url.search,
        kind: where.kind,
        t,
        pageMs: pageStart == null ? null : t - pageStart,
        sandbox: undefined,
        cls: undefined,
        status: null,
        committed: false,
        failure: null,
        redirects: 0,
        unread: null,
      };
      loads.push(row);
      byRequest.set(req, row);
      if (!frame) {
        row.unread = "the request has no frame";
        return;
      }
      const read = (async () => {
        const el = await frame.frameElement();
        try {
          const [sandbox, cls] = await Promise.all([el.getAttribute("sandbox"), el.getAttribute("class")]);
          row.sandbox = sandbox;
          row.cls = cls;
        } finally {
          await el.dispose().catch(() => undefined);
        }
      })().catch((err) => {
        row.unread = `the iframe could not be read: ${String(err?.message ?? err).split("\n")[0]}`;
      });
      pending.add(read);
      read.finally(() => pending.delete(read));
    };
    const onResponse = (res) => {
      const row = byRequest.get(res.request());
      if (row) row.status = res.status();
    };
    const onFailed = (req) => {
      const row = byRequest.get(req);
      if (row) row.failure = req.failure()?.errorText ?? "failed";
    };
    const onNavigated = (frame) => {
      if (!frameIndex.has(frame)) return;
      const here = strip(frame.url());
      for (let i = loads.length - 1; i >= 0; i -= 1) {
        const r = loads[i];
        if (r.frame === frame && !r.committed && strip(r.url) === here) {
          r.committed = true;
          break;
        }
      }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailed);
    page.on("framenavigated", onNavigated);
    const settled = async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    };
    return {
      loads,
      summary: () => loads.map(({ frame: _frame, url: _url, ...rest }) => ({ ...rest })),
      settled,
      stop: () => {
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfailed", onFailed);
        page.off("framenavigated", onNavigated);
        return settled();
      },
    };
  }

  /**
   * Record every element of the top document that matches `selector` (a CSS
   * selector) and, when `text` is given, whose textContent contains it (a
   * string) or matches it (a RegExp), from now until `stop()`: the oracle for
   * "this never appeared, not even for one render" (see the header). Polling
   * cannot prove that; this looks after every DOM change, before the render.
   *
   * Resolves (once installed in the current document and for every later
   * one) {selector, text, sightings(), documents(), stop()}:
   *   sightings() → Promise<[{seq, doc, t, goneAt, gone, path, text, visible}]>
   *     one row per element from when it began to match. `t` and `goneAt` are
   *     the page's Date.now() (the same clock as this process's); `gone` is
   *     null while it still matches, "removed" once it stopped (removed, or
   *     its text, class or attributes changed), "navigation" when its document
   *     went (then `goneAt` is when the next one started). `doc` numbers the
   *     documents watched (1: the one current at the call), `path` is the
   *     pathname, `text` the element's text (trimmed, 500 characters),
   *     `visible` whether it had a box as it appeared (checkVisibility).
   *     It reads the current document's own record first, so a sighting
   *     that has not reached Node yet is still in it.
   *   documents() → Promise<[{doc, t, path, via}]> each document watched:
   *     `via` "call" (the one current at the call, from then on) or "load"
   *     (a later one, from before its first script).
   *   stop() → Promise<rows>: no rows after it, in this document or a later
   *     one; later sightings() return the same rows.
   *
   * An element added and removed again before the observer looks (within one
   * task's microtasks) was never rendered and is no row. Child frames, the
   * document frame among them, are not watched.
   */
  async watchFor(selector, text = null) {
    const name = this.name;
    if (typeof selector !== "string" || selector.trim() === "") throw new Error(`${name}: watchFor selector is a CSS selector, got ${showValue(selector)}`);
    if (!(text === null || text instanceof RegExp || (typeof text === "string" && text.length > 0))) {
      throw new Error(`${name}: watchFor text is a non-empty string, a RegExp or null, got ${showValue(text)}`);
    }
    const page = this.page;
    const invalid = await page.evaluate((sel) => {
      try {
        document.createDocumentFragment().querySelector(sel);
        return null;
      } catch (e) {
        return String(e?.message ?? e);
      }
    }, selector);
    if (invalid !== null) throw new Error(`${name}: watchFor selector ${JSON.stringify(selector)} is not one querySelectorAll takes: ${invalid}`);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const arg = {
      key: `__e2eWatch_${id}`,
      binding: `__e2eWatchReport_${id}`,
      selector,
      text: typeof text === "string" ? text : null,
      re: text instanceof RegExp ? { source: text.source, flags: text.flags } : null,
    };
    const docs = [];
    const byDoc = new Map();
    let stopped = false;
    let final = null;
    const docOf = (doc, t, path, via) => {
      let d = byDoc.get(doc);
      if (!d) {
        // A new document: what the earlier ones still showed went with them.
        for (const prev of docs) {
          for (const r of prev.rows.values()) {
            if (r.goneAt === null) {
              r.goneAt = t;
              r.gone = "navigation";
            }
          }
        }
        d = { doc, index: docs.length + 1, t, path, via, rows: new Map() };
        docs.push(d);
        byDoc.set(doc, d);
      }
      if (d.via == null && via != null) d.via = via;
      return d;
    };
    await page.exposeBinding(arg.binding, (_source, msg) => {
      if (stopped) return "stop";
      if (!msg || typeof msg.doc !== "string") return null;
      if (msg.type === "install") {
        docOf(msg.doc, msg.t, msg.path, msg.via);
        return null;
      }
      const d = docOf(msg.doc, msg.row?.t ?? now(), msg.row?.path ?? null, null);
      if (msg.type === "seen" && msg.row && !d.rows.has(msg.row.id)) d.rows.set(msg.row.id, { ...msg.row, gone: null });
      if (msg.type === "gone") {
        const r = d.rows.get(msg.id);
        if (r && r.goneAt === null) {
          r.goneAt = msg.t;
          r.gone = "removed";
        }
      }
      return null;
    });
    await page.addInitScript(domWatcher, { ...arg, via: "load" });
    // The current document from now; a navigation racing this leaves it to the init script.
    await page.evaluate(domWatcher, { ...arg, via: "call" }).catch((err) => {
      if (page.isClosed()) throw err;
    });
    const rowsNow = () => {
      let seq = 0;
      return docs.flatMap((d) =>
        [...d.rows.values()]
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ seq: seq++, doc: d.index, t: r.t, goneAt: r.goneAt, gone: r.gone, path: r.path, text: r.text, visible: r.visible })),
      );
    };
    const read = async (op) => {
      const snap = page.isClosed() ? null : await page.evaluate(({ key, op }) => window[key]?.[op]?.() ?? null, { key: arg.key, op }).catch(() => null);
      if (snap) {
        // The current document's own record is the whole truth for it.
        const d = docOf(snap.doc, snap.t, snap.path, null);
        for (const r of snap.rows) d.rows.set(r.id, { ...r, gone: r.goneAt === null ? null : "removed" });
      }
      return rowsNow();
    };
    const copy = (rows) => rows.map((r) => ({ ...r }));
    return {
      selector,
      text,
      sightings: async () => (final ? copy(final) : read("snapshot")),
      documents: async () => {
        if (!final) await read("snapshot");
        return docs.map((d) => ({ doc: d.index, t: d.t, path: d.path, via: d.via }));
      },
      stop: async () => {
        if (!final) {
          final = await read("stop");
          stopped = true;
        }
        return copy(final);
      },
    };
  }

  /**
   * Open /d/<docId>[/<v>][?k=] and wait for the viewer and its frame,
   * resolving what waitForFrame does: {src, sandbox, editable}.
   *
   * Two options, both off by default (a call without them is exactly as
   * before), make it stand up to a loaded shared stack (see the header's
   * OPENING ON A LOADED STACK):
   *
   * `reloads` (0): how many times the page may be loaded again after the
   * stack stalled THAT load: the wait for the viewer and its frame ran out
   * while the page saw the stack stall in it (lib/test.mjs stallEvidence),
   * or, with `sessionCheck`, the load's POST /session answered Hosting's
   * cut-off. A wait that runs out with no such evidence is not loaded again.
   *
   * `sessionCheck` (false), for a signed-in user: once the frame shows, wait
   * for the load's own POST /session to be sent (within `timeout`) and
   * answered (within `timeout` or 75 s of being sent, whichever is longer, so
   * Hosting's 60 s cut-off always arrives as an answer), and judge it. The
   * cut-off loads the page again while `reloads` allow, and otherwise throws
   * E2E_STACK_CUTOFF (lib/test.mjs stackCutoff), `response` the entry. Any
   * other answer, a refusal included, stands.
   *
   * With either, it resolves {src, sandbox, editable, loads, stall, session}.
   */
  async open(docId, { v = null, k = null, timeout = 45_000, reloads = 0, sessionCheck = false } = {}) {
    const path = `/d/${encodeURIComponent(docId)}${v ? `/${encodeURIComponent(v)}` : ""}${k ? `?k=${encodeURIComponent(k)}` : ""}`;
    if (!Number.isInteger(reloads) || reloads < 0) throw new Error(`${this.name}: open reloads is a whole number 0 or more, got ${showValue(reloads)}`);
    if (sessionCheck !== true && sessionCheck !== false) throw new Error(`${this.name}: open sessionCheck is true or false, got ${showValue(sessionCheck)}`);
    if (reloads === 0 && !sessionCheck) {
      await this.goto(path, { waitUntil: "load", timeout });
      return this.waitForFrame({ timeout });
    }
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`${this.name}: open timeout is a number of ms above 0, got ${showValue(timeout)}`);
    // Messages name the path without its query: `?k=` is a link key.
    const label = `/d/${encodeURIComponent(docId)}${v ? `/${encodeURIComponent(v)}` : ""}`;
    return openOnLoadedStack(this, { path, label, timeout, reloads, sessionCheck });
  }

  /** `.share-state`'s data-state, or "off" when the editor shows none. */
  async shareState() {
    return this.page.evaluate(() => document.querySelector(".share-state")?.getAttribute("data-state") ?? "off");
  }

  async saveState() {
    return this.page.evaluate(() => document.querySelector(".save-state")?.getAttribute("data-state") ?? null);
  }

  /**
   * Press Edit and wait for the Formatting toolbar and an editable frame body.
   * With `waitShared`, also wait for the live session to report "Shared";
   * otherwise only for it to stop "Joining…". Resolves {share, frame}: the
   * press, then awaitEdit's waits.
   */
  async enterEdit({ waitShared = false, timeout = 45_000 } = {}) {
    await this.page.locator('.viewer-toolbar [aria-label="Edit"]').first().click();
    return this.awaitEdit({ waitShared, timeout });
  }

  /**
   * enterEdit's waits WITHOUT its press, for an Edit press made elsewhere: in
   * the page at a shared instant (lib/sync.mjs syncPages, SYNC-T), or a
   * press whose editable /draft/ frame a route holds (holdRequests, SYNC-H),
   * which a second click would press again. Marks the user as in edit
   * (`inEdit`, which settleLive reads) at once, then waits, each wait up to
   * `timeout`, for the Formatting toolbar, an editable /draft/ frame, and
   * the share state: "shared" with `waitShared`, otherwise anything but
   * "joining". Never clicks anything. Resolves {share, frame}, as enterEdit.
   * A wait that runs out throws as enterEdit's does; deciding whether that is
   * a failed sync precondition (INCONCLUSIVE) is the caller's.
   */
  async awaitEdit({ waitShared = false, timeout = 45_000 } = {}) {
    this.inEdit = true;
    await this.page.getByRole("toolbar", { name: "Formatting" }).waitFor({ state: "visible", timeout });
    const frame = await this.waitForFrame({ timeout, match: /\/draft\//, editable: true });
    const share = await this.poll(
      async () => {
        const s = await this.shareState();
        if (waitShared) return s === "shared" ? s : null;
        return s === "joining" ? null : s;
      },
      { timeout, what: waitShared ? 'share-state "shared"' : "the live session to finish joining" },
    );
    return { share, frame };
  }

  /**
   * Type into the document frame with real input. A REAL click inside the
   * frame comes first — at the element's text end (or start), mapped through
   * the frame's CSS scale — because keystrokes otherwise go to the parent.
   * Then the caret is collapsed exactly at the end/start (selection only).
   */
  async typeInFrame(target, text, { delay = 0, at = "end" } = {}) {
    const frame = await this.frame();
    let inner;
    if (typeof target === "string") inner = await elementPoint(frame, target, at === "start" ? "start" : "end");
    else inner = target;
    // Measured AFTER elementPoint: scrollIntoView in a same-origin frame can
    // scroll the parent too, which moves the iframe.
    const geom = await frameGeometry(this.page);
    const p = framePointToPage(geom, inner);
    if (!insideFrame(geom, p)) throw new Error(`${this.name}: point ${JSON.stringify(p)} is outside the frame ${JSON.stringify(geom.rect)}`);
    await this.page.mouse.click(p.x, p.y);
    if (typeof target === "string" && at !== "point") await placeCaret(frame, target, at);
    const focus = await focusState(frame);
    if (!focus.hasFocus) throw new Error(`${this.name}: the frame does not have focus after clicking ${JSON.stringify(p)}`);
    await this.page.keyboard.type(text, { delay });
    return { clickedAt: p, scale: geom.scaleX, focus };
  }

  /**
   * A real left click inside the document frame, with no typing and no caret
   * placed: the click typeInFrame makes. `target` is a selector, clicked at
   * its centre, its first line's start or its last line's end (`where`), or a
   * point in the frame's own viewport. Mapped through the frame's CSS scale.
   *
   * Before clicking it hit-tests the point: the page's topmost element there
   * must be the document iframe (not a toolbar, a FAB or a loading cover over
   * it), and the frame's element there must be the target or inside it. A
   * miss throws, because a click that lands elsewhere passes or fails a case
   * for the wrong reason; `hitTest: false` clicks regardless. Returns
   * {clickedAt (page point), inner (frame point), scale, hit: {page, frame} | null}.
   */
  async clickInFrame(target, { where = "center", hitTest = true } = {}) {
    if (!["center", "start", "end"].includes(where)) throw new Error(`${this.name}: clickInFrame where must be "center", "start" or "end", got ${JSON.stringify(where)}`);
    const frame = await this.frame();
    const selector = typeof target === "string" ? target : null;
    const inner = selector ? await elementPoint(frame, selector, where) : target;
    // Measured AFTER elementPoint, which scrolls: see typeInFrame.
    const geom = await frameGeometry(this.page);
    const p = framePointToPage(geom, inner);
    const what = selector ?? `point ${JSON.stringify(inner)}`;
    if (!insideFrame(geom, p)) throw new Error(`${this.name}: ${what} at ${JSON.stringify(p)} is outside the frame ${JSON.stringify(geom.rect)}`);
    let hit = null;
    if (hitTest) {
      hit = await hitAt(this.page, frame, p, inner, selector);
      if (!hit.ok) {
        const lands = hit.page === "frame" ? `${hit.frame} in the frame` : `the page's ${hit.page}`;
        throw new Error(`${this.name}: a click at ${JSON.stringify(p)} would land on ${lands}, not ${what}`);
      }
      delete hit.ok;
    }
    await this.page.mouse.click(p.x, p.y);
    return { clickedAt: p, inner, scale: geom.scaleX, hit };
  }

  /** Leave the editor ("Done"). */
  async done({ timeout = 30_000 } = {}) {
    const bar = this.page.getByRole("toolbar", { name: "Formatting" });
    await bar.getByRole("button", { name: "Done", exact: true }).click();
    await bar.waitFor({ state: "detached", timeout });
    this.inEdit = false;
  }

  /**
   * Press "Save as new version" and resolve on the outcome toast:
   * {outcome: published|nochange|conflict|save-failed|error, text, versionId}.
   */
  async saveAsNewVersion({ timeout = 60_000 } = {}) {
    const since = this.toastMark();
    await this.page.getByRole("button", { name: "Save as new version", exact: true }).click();
    const toast = await this.waitForToast(
      (t) => COMMIT_OUTCOMES.some((o) => o.re.test(t.text)) || t.kind === "error",
      { since, timeout },
    );
    const hit = COMMIT_OUTCOMES.find((o) => o.re.test(toast.text));
    // A commit that published (or found nothing to publish) leaves the editor (DocViewer).
    if (hit?.outcome === "published" || hit?.outcome === "nochange") this.inEdit = false;
    return {
      outcome: hit ? hit.outcome : "error",
      text: toast.text,
      versionId: hit?.outcome === "published" ? hit.re.exec(toast.text)[1] : null,
      toast,
    };
  }

  /**
   * Wait for the autosave that follows an edit (see the header): the first
   * POST /draft the browser started at or after `after`, answered, and then
   * the toolbar's save state following it ("saved", or "error" for a refusal).
   * A save that began before the edit, and so lacks it, is never the one,
   * even when its answer comes later.
   *
   * `after` is the time of the last edit, `Date.now()` taken once the edit's
   * action has resolved (the debounce means the save it causes starts a whole
   * AUTOSAVE_MS later); anything that is not such a time throws, so a
   * responseMark() passed by mistake cannot match every save. `expectStatus`
   * is a status, a list, or null for any; another throws "the autosave after
   * the last edit was answered <status> <body> (wanted …)".
   *
   * Resolves {status, body, saveState, startedAt, clock, entry}: `body` the
   * answer's JSON (`{draft}`) or null, `startedAt` when the browser started
   * the request and `clock` whose clock that is ("browser"; "node" when the
   * response carried no timing, which is later than the real start), `entry`
   * the User.responses entry (its `postJson.html` is what was saved).
   */
  async waitForAutosave({ after, timeout = 20_000, expectStatus = 200 } = {}) {
    if (!Number.isFinite(after) || after < 1e12) {
      throw new Error(`${this.name}: waitForAutosave after is the time of the last edit, Date.now() taken once it was made, got ${JSON.stringify(after)}`);
    }
    const want = statusList(this.name, "waitForAutosave", expectStatus);
    const deadline = now() + timeout;
    let save = null;
    for (;;) {
      for (const entry of this.findResponses(DRAFT_POST)) {
        const s = requestStart(entry);
        if (s.startedAt >= after) {
          save = { ...s, entry };
          break;
        }
      }
      if (save || now() >= deadline) break;
      await sleep(50);
    }
    if (!save) {
      const seen = this.findResponses(DRAFT_POST).slice(-6).map((r) => {
        const d = Math.round(requestStart(r).startedAt - after);
        return `${d >= 0 ? "+" : ""}${d} ms ${r.status}`;
      });
      const state = await this.saveState().catch(() => null);
      throw new Error(`${this.name}: no POST /draft started after the last edit was answered within ${timeout} ms (save state ${JSON.stringify(state)}; POST /draft seen, by start relative to the edit: ${seen.join(", ") || "none"})`);
    }
    const { entry } = save;
    const body = await responseJson(entry.response);
    if (want && !want.includes(entry.status)) {
      throw new Error(`${this.name}: the autosave after the last edit was answered ${entry.status} ${String(JSON.stringify(body)).slice(0, 300)} (wanted ${want.join(" or ")})`);
    }
    const settleOn = entry.status >= 200 && entry.status < 300 ? "saved" : "error";
    // The toolbar follows the answer once the page has read it.
    const saveState = await this.poll(
      async () => {
        const st = await this.saveState();
        return st === settleOn ? st : null;
      },
      { timeout: Math.max(2_000, deadline - now()), interval: 50, what: `the save state "${settleOn}" after the autosave's ${entry.status}` },
    );
    return { status: entry.status, body, saveState, startedAt: save.startedAt, clock: save.clock, entry };
  }

  /**
   * Type into the document frame (typeInFrame: a real click, then the keys),
   * press Backspace `thenBackspace` times (an edit that changes nothing still
   * makes a save), and wait for the autosave that follows the last key
   * (waitForAutosave). The last key's time is the document's own last `input`
   * event, read in the page; when typing fires none (no editor on the frame),
   * it throws at once instead of waiting for a save that never comes.
   *
   * Resolves waitForAutosave's {status, body, saveState, startedAt, clock,
   * entry} plus `typed` (typeInFrame's result), `inputs` (how many input
   * events the keys fired; null when the page could not count them, and then
   * `after` is this process's time) and `after` (the last one's time).
   */
  async typeAndAutosave(target, text, { delay = 15, at = "end", thenBackspace = 0, timeout = 20_000, expectStatus = 200 } = {}) {
    if (typeof text !== "string") throw new Error(`${this.name}: typeAndAutosave types a string, got ${typeof text}`);
    if (!Number.isInteger(thenBackspace) || thenBackspace < 0) throw new Error(`${this.name}: typeAndAutosave thenBackspace is a count of presses, got ${JSON.stringify(thenBackspace)}`);
    if (text === "" && thenBackspace === 0) throw new Error(`${this.name}: typeAndAutosave has nothing to type ("" and no Backspace), so no edit and no autosave would follow`);
    statusList(this.name, "typeAndAutosave", expectStatus);
    const key = `__e2eInputs${Math.random().toString(36).slice(2)}`;
    // A listener in the PAGE's world on the frame's document, as the editor's
    // own is: it changes no node and no attribute, so nothing of it is saved.
    const counting = await this.page
      .evaluate(
        ({ sel, key }) => {
          const doc = document.querySelector(sel)?.contentDocument;
          if (!doc) return false;
          const s = { n: 0, last: null, doc };
          s.fn = () => {
            s.n += 1;
            s.last = Date.now();
          };
          doc.addEventListener("input", s.fn, true);
          window[key] = s;
          return true;
        },
        { sel: DOC_FRAME, key },
      )
      .catch(() => false);
    let typed;
    let failure = null;
    try {
      typed = await this.typeInFrame(target, text, { delay, at });
      for (let i = 0; i < thenBackspace; i += 1) await this.page.keyboard.press("Backspace");
    } catch (err) {
      failure = err;
    }
    const typedAt = now();
    const count = counting
      ? await this.page
          .evaluate((key) => {
            const s = window[key];
            if (!s) return null;
            s.doc.removeEventListener("input", s.fn, true);
            delete window[key];
            return { n: s.n, last: s.last };
          }, key)
          .catch(() => null)
      : null;
    if (failure) throw failure;
    const what = typeof target === "string" ? target : `point ${JSON.stringify(target)}`;
    if (count && count.n === 0) {
      throw new Error(`${this.name}: typing ${JSON.stringify(text)}${thenBackspace ? ` and ${thenBackspace} Backspace` : ""} into ${what} fired no input event in the document, so no autosave follows (is the editor open?)`);
    }
    const after = count?.last ?? typedAt;
    const save = await this.waitForAutosave({ after, timeout, expectStatus });
    return { ...save, typed, inputs: count ? count.n : null, after };
  }

  /**
   * Select `exact` inside `selector` in the frame by dragging the real mouse
   * from its first character to its last, so the app sees a real selection
   * (and shows the selection FAB in reading mode). Falls back to setting the
   * Range when the drag did not select exactly that text, and says so.
   */
  async selectText(selector, exact, { occurrence = 0, fab = null, timeout = 10_000 } = {}) {
    const frame = await this.frame();
    const rr = await rangeRects(frame, selector, exact, { occurrence });
    if (rr.error) throw new Error(`${this.name}: ${rr.error}`);
    const geom = await frameGeometry(this.page);
    const start = framePointToPage(geom, { x: rr.first.x + Math.min(1, rr.first.width / 4), y: rr.first.y + rr.first.height / 2 });
    const end = framePointToPage(geom, { x: rr.last.x + rr.last.width - Math.min(1, rr.last.width / 4), y: rr.last.y + rr.last.height / 2 });
    await this.drag(start, end, { steps: 8 });
    let text = (await selectionText(frame)).trim();
    let via = "drag";
    if (text !== exact.trim()) {
      text = (await setSelection(frame, selector, exact, { occurrence })).trim();
      via = "range-fallback";
    }
    const editing = await this.page.getByRole("toolbar", { name: "Formatting" }).isVisible();
    if (fab ?? !editing) await this.page.locator(".selection-fab").first().waitFor({ state: "visible", timeout });
    return { via, text, rects: rr.rects.length };
  }

  /**
   * Select from text in one element to text in another by dragging the real
   * mouse from the first character of `from.exact` to the last character of
   * `to.exact`, so the selection holds whatever lies between: paragraphs, a
   * <br>, a list, a table. Each end is `{sel, exact, occurrence = 0}`; one
   * element may be both ends. `from` is scrolled into view; `to` is measured
   * where it then is.
   *
   * Falls back to setting the same Range (setSelectionBetween) when a drag
   * cannot reach both ends (one is outside the frame's painted box) or did
   * not select from `from` to `to`, and says so in `via`. As selectText, it
   * then waits for the selection toolbar when reading (`fab`, default: unless
   * the Formatting toolbar is showing).
   *
   * Returns {via: "drag" | "range-fallback", text}: `text` is the selected
   * Range's text, trimmed (Range.toString(): the raw text anchors are measured
   * against, with the source's whitespace between blocks).
   */
  async selectBetween(from, to, { fab = null, steps = 10, timeout = 10_000 } = {}) {
    const frame = await this.frame();
    for (const [name, end] of [["from", from], ["to", to]]) {
      if (!end || typeof end.sel !== "string" || typeof end.exact !== "string" || end.exact === "") {
        throw new Error(`${this.name}: selectBetween ${name} is {sel, exact, occurrence?} with a non-empty exact, got ${JSON.stringify(end)}`);
      }
    }
    const a = await rangeRects(frame, from.sel, from.exact, { occurrence: from.occurrence ?? 0 });
    if (a.error) throw new Error(`${this.name}: ${a.error}`);
    const b = await rangeRects(frame, to.sel, to.exact, { occurrence: to.occurrence ?? 0, scroll: false });
    if (b.error) throw new Error(`${this.name}: ${b.error}`);
    // Measured AFTER rangeRects, which scrolls: see typeInFrame.
    const geom = await frameGeometry(this.page);
    const start = framePointToPage(geom, { x: a.first.x + Math.min(1, a.first.width / 4), y: a.first.y + a.first.height / 2 });
    const end = framePointToPage(geom, { x: b.last.x + b.last.width - Math.min(1, b.last.width / 4), y: b.last.y + b.last.height / 2 });
    let via = "range-fallback";
    let text = null;
    if (insideFrame(geom, start) && insideFrame(geom, end)) {
      await this.drag(start, end, { steps });
      const got = await selectionBetween(frame, from, to);
      if (got.ok) {
        via = "drag";
        text = got.text;
      }
    }
    if (text === null) text = await setSelectionBetween(frame, from, to);
    const editing = await this.page.getByRole("toolbar", { name: "Formatting" }).isVisible();
    if (fab ?? !editing) await this.page.locator(".selection-fab").first().waitFor({ state: "visible", timeout });
    return { via, text: text.trim() };
  }

  /**
   * A real left-button drag from `start` to `end` (page coordinates), sent as
   * raw CDP Input.dispatchMouseEvent — the same input path page.mouse uses.
   * Not page.mouse.move with the button down: Playwright then intercepts the
   * move to detect a drag-and-drop, and over a scriptless sandboxed iframe
   * (the app's reading frame) that interception never settles — measured:
   * the move hangs until the page is closed.
   */
  async drag(start, end, { steps = 8 } = {}) {
    if (!this.cdp || this.cdpPage !== this.page) {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdpPage = this.page;
    }
    const send = (type, p, extra = {}) =>
      this.cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, ...extra });
    await send("mouseMoved", start, { button: "none", buttons: 0 });
    await send("mousePressed", start);
    for (let i = 1; i <= steps; i += 1) {
      await send("mouseMoved", { x: start.x + ((end.x - start.x) * i) / steps, y: start.y + ((end.y - start.y) * i) / steps });
    }
    await send("mouseReleased", end, { buttons: 0 });
  }

  /**
   * A finger on the touch screen: one tap at `point`, {x, y} in the page's
   * CSS px (the viewport's coordinates, as Playwright's boundingBox() gives
   * them; a point inside the document frame goes through frame.mjs
   * framePointToPage first), held `durationMs` (50, Chrome's own tap, by
   * default; 1,200 is a long press). Chrome's own gesture,
   * Input.synthesizeTapGesture on the page's CDP session (drag's), so the
   * page sees what a finger makes: pointerdown and pointerup of pointerType
   * "touch", touchstart, touchend, and for a short tap mousedown, mouseup and
   * a click; a long press selects the word under it and raises contextmenu
   * instead (measured with Chrome 154). Resolves {x, y, durationMs, tappedAt}
   * (tappedAt the Date.now() it was sent at) once the finger has lifted.
   *
   * Only a touch user taps (`device: {…, touch: true}`): Chrome synthesizes
   * the gesture on any page, so on a mouse user it would tap a page whose
   * `(pointer: coarse)` styles never applied, and that throws before anything
   * is sent. So does a point that is not two finite numbers, or a
   * `durationMs` that is not a whole number of ms, 0 or more (Chrome refuses a
   * fraction as "Invalid parameters"). A point outside the viewport is
   * Chrome's own refusal, "Position out of bounds": scroll it into view first.
   */
  async tap(point, { durationMs = 50 } = {}) {
    if (this.device?.touch !== true) {
      throw new Error(`${this.name}: tap() is a finger on a touch screen, and this user was made with a mouse (device ${showValue(this.device)}); make it with device {width, height, touch: true}`);
    }
    const { x, y } = point ?? {};
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`${this.name}: tap(point) takes {x, y}, finite CSS px in the page's viewport, got ${showValue(point)}`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) throw new TypeError(`${this.name}: tap(): durationMs is a whole number of ms, 0 or more, got ${showValue(durationMs)}`);
    if (!this.cdp || this.cdpPage !== this.page) {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdpPage = this.page;
    }
    const tappedAt = now();
    await this.cdp.send("Input.synthesizeTapGesture", { x, y, duration: durationMs, tapCount: 1, gestureSourceType: "touch" });
    return { x, y, durationMs, tappedAt };
  }

  /**
   * Slow this user's page `rate` times, as DevTools' CPU throttling does
   * (Emulation.setCPUThrottlingRate on a CDP session of the page), until the
   * returned `restore()` is called (see the header for what it slows).
   * `rate` is a finite number of at least 1, where 1 is full speed; anything
   * else throws a TypeError before anything is sent (Chrome itself takes 0 or
   * a negative rate as full speed). It is the page that is `this.page` at the
   * call, and stays that page's. Calls stack: the latest throttle still in
   * force sets the rate, so `throttleCpu(1)` runs at full speed until its own
   * restore. `restore()` takes this throttle away, in any order, and resolves
   * to the rate then in force (1 when no other is); a second call is the
   * first's promise. Once the page has closed it restores nothing and
   * resolves 1.
   */
  async throttleCpu(rate) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 1) {
      throw new TypeError(`${this.name}: throttleCpu rate is a finite number of at least 1 (1 is full speed), got ${typeof rate === "string" ? JSON.stringify(rate) : String(rate)}`);
    }
    const page = this.page;
    let t = this.cpuThrottles.get(page);
    if (!t) {
      t = { session: this.context.newCDPSession(page), active: [] };
      this.cpuThrottles.set(page, t);
      // A failed attach is not kept: the next call attaches again.
      t.session.catch(() => {
        if (this.cpuThrottles.get(page) === t) this.cpuThrottles.delete(page);
      });
    }
    // The rate in force is read once the session is there, in the same tick
    // as the send: of calls made together, every send carries the latest.
    const apply = async () => {
      const session = await t.session;
      const now = t.active.at(-1)?.rate ?? 1;
      await session.send("Emulation.setCPUThrottlingRate", { rate: now });
      return now;
    };
    const entry = { rate };
    t.active.push(entry);
    try {
      await apply();
    } catch (err) {
      t.active.splice(t.active.indexOf(entry), 1);
      throw new Error(`${this.name}: throttleCpu(${rate}) was not applied: ${String(err?.message ?? err).split("\n")[0]}`, { cause: err });
    }
    let restored = null;
    return () =>
      (restored ??= (async () => {
        t.active.splice(t.active.indexOf(entry), 1);
        if (page.isClosed()) return 1;
        try {
          return await apply();
        } catch (err) {
          if (page.isClosed()) return 1;
          throw new Error(`${this.name}: the restore of throttleCpu(${rate}) was not applied: ${String(err?.message ?? err).split("\n")[0]}`, { cause: err });
        }
      })());
  }

  /**
   * The thread list item quoting `quote` (a substring, as Playwright's
   * hasText), or the selected one when quote is null. A comment thread shows
   * its quote in `.thread-quote`; a suggestion shows it struck in its change,
   * or in its Edit form while that is open. `kind` narrows the match:
   * "comment", "suggestion" or "any" (the default).
   */
  thread(quote = null, { kind = "any" } = {}) {
    if (!Object.hasOwn(THREAD_QUOTE, kind)) throw new Error(`${this.name}: thread kind must be "any", "comment" or "suggestion", got ${JSON.stringify(kind)}`);
    const quoteSel = THREAD_QUOTE[kind];
    const threads = this.page.locator(".comments-panel .thread");
    return quote == null ? threads.and(this.page.locator('[aria-selected="true"]')) : threads.filter({ has: this.page.locator(quoteSel, { hasText: quote }) });
  }

  /**
   * Open the comments panel if it is closed (it starts closed when every
   * thread is resolved). It reads the panel's state, presses the toggle only
   * while that reads closed, waits briefly for it to open, and repeats until
   * `timeout`: the first annotation snapshot can open the panel between a
   * read and a press, which a single press would then close (see the header).
   * Resolves `{presses}`, how many presses it took (0 when it was open).
   */
  async openComments({ timeout = 10_000 } = {}) {
    const body = this.page.locator(".viewer-body").first();
    const toggle = this.page.locator('.viewer-toolbar-actions button[aria-label="Comments"]').first();
    const panel = this.page.locator('.viewer-body[data-comments="open"] .comments-panel').first();
    const deadline = now() + timeout;
    const left = () => Math.max(1, deadline - now());
    // One Playwright step is never given less than 2 s, so near the deadline it still reaches the element and the deadline's own message is what throws.
    const step = () => Math.max(left(), 2_000);
    let presses = 0;
    let state = null;
    for (;;) {
      state = await body.getAttribute("data-comments", { timeout: step() });
      if (state === "open") {
        // Open: never press, or the press would close it; wait for the panel to show.
        if (await panel.waitFor({ state: "visible", timeout: Math.min(1_500, left()) }).then(() => true, () => false)) return { presses };
      } else {
        if (now() >= deadline) break;
        await toggle.click({ timeout: step() });
        presses += 1;
        if (await panel.waitFor({ state: "visible", timeout: Math.min(1_500, left()) }).then(() => true, () => false)) return { presses };
      }
      if (now() >= deadline) break;
    }
    throw new Error(`${this.name}: the comments panel did not open within ${timeout} ms (data-comments "${state}", ${presses} press${presses === 1 ? "" : "es"})`);
  }

  /**
   * Comment on the current selection: the FAB's Comment button, then the
   * reply box of the thread THAT PRESS made, never another one still selected
   * from before it (see the header): it waits for a selected thread that was
   * not on the page before the press, types `text` into its reply box, presses
   * Enter, and waits for the text to show in that thread. An error toast
   * instead (the annotation was refused) throws at once with the app's words.
   * `timeout` bounds each of the two waits, as it always did: for the new
   * thread, then for the comment in it. Resolves {quote}: the new thread's
   * quote.
   *
   * A LOADED EMULATOR'S REFUSAL. The Firestore emulator under load fails a
   * rule's get() ("Service call error. Function: [get], …", in the app's
   * error toast: RULES_SERVICE_ERROR_RE), which is the stack failing, not the
   * rules' verdict. With `retryServiceError: n` and `reselect` (async () =>
   * …, which selects the passage again: a refused press may leave none), a
   * press refused so is made again, up to n more times, `SERVICE_RETRY_MS`
   * (3 s) apart, and it resolves {quote, serviceErrors}: how many presses were
   * refused so. Any other toast throws at once, as before. When every press
   * was refused so, it throws the last refusal with `serviceErrors` and a
   * `stackCut` naming them, so a case with inconclusiveOnStackTimeout ends
   * INCONCLUSIVE (lib/test.mjs stackDidNotAnswer). Without the option nothing
   * changes: one press, and its refusal throws as it is.
   */
  async comment(text, { timeout = 20_000, retryServiceError = 0, reselect = null } = {}) {
    if (typeof text !== "string" || text === "") throw new Error(`${this.name}: comment takes a non-empty text, got ${showValue(text)}`);
    if (!Number.isInteger(retryServiceError) || retryServiceError < 0) throw new Error(`${this.name}: comment retryServiceError is how many more presses a "Service call error" may cost, a whole number 0 or more, got ${showValue(retryServiceError)}`);
    if (reselect !== null && typeof reselect !== "function") throw new Error(`${this.name}: comment reselect is async () => … that selects the passage again, or null, got ${typeof reselect}`);
    if (retryServiceError > 0 && reselect === null) throw new Error(`${this.name}: comment retryServiceError needs reselect, async () => … that selects the passage again (a refused press may leave no selection)`);
    if (retryServiceError === 0) return commentPress(this, text, timeout);
    let serviceErrors = 0;
    for (;;) {
      try {
        return { ...(await commentPress(this, text, timeout)), serviceErrors };
      } catch (err) {
        if (!(err?.toast?.kind === "error" && RULES_SERVICE_ERROR_RE.test(String(err.toast.text ?? "")))) throw err;
        serviceErrors += 1;
        if (serviceErrors > retryServiceError) {
          err.serviceErrors = serviceErrors;
          err.stackCut = `${this.name}: the emulator failed a rule's get() ("Service call error") on ${serviceErrors} Comment press(es) in a row, so the rules never judged the write`;
          err.message = `${err.message} (${serviceErrors} press(es), each refused with "Service call error")`;
          throw err;
        }
        await sleep(SERVICE_RETRY_MS);
        await reselect();
      }
    }
  }

  /**
   * Press a control whose press makes a rules-guarded client write (a
   * dialog's button), and wait for its outcome: `done()` (async () => truthy
   * once the press took effect: the dialog closed, the grant shown; a throw
   * counts as "not yet") or an error toast, the write refused. `locator` is
   * a selector on the page (its first match) or a Playwright Locator.
   *
   * A LOADED EMULATOR'S REFUSAL, as at `comment`: a refusal with "Service
   * call error" (RULES_SERVICE_ERROR_RE) is the emulator failing a rule's
   * get(), not the rules' verdict, so after `backoffMs` (SERVICE_RETRY_MS, 3
   * s) every toast showing that has a Dismiss is dismissed (dismissToasts:
   * the refusals stay up, and three of them stacked cover a dialog's
   * buttons) and the control is pressed again, up to `retries` more times.
   * Resolves {serviceErrors}: how many presses were refused so. Any other
   * error toast throws at once, "<user>: the press of "<what>" was refused:
   * the app said "<toast>"", the toast as `toast`, no `stackCut`. When every
   * press was refused so, the last refusal throws with `serviceErrors` and a
   * `stackCut` ("<user>: the emulator failed a rule's get() ("Service call
   * error") on N press(es) of "<what>" in a row, so the rules never judged the
   * write"), so a case with inconclusiveOnStackTimeout ends INCONCLUSIVE
   * (lib/test.mjs stackDidNotAnswer). Neither within `timeout` of a press
   * throws "<user>: the press of "<what>" took no effect within <timeout> ms,
   * and no error toast came", a wait pageStall reads, the last throw of
   * `done` as its cause. `timeout` also bounds each press (Playwright's
   * click). `what` names the control in messages; by default the selector,
   * or the locator as Playwright prints it. A bad argument throws TypeError
   * before anything is pressed.
   */
  async pressRetryingServiceError(locator, { retries = 3, backoffMs = SERVICE_RETRY_MS, done, timeout = 30_000, what = null } = {}) {
    const me = `${this.name}: pressRetryingServiceError`;
    const isLocator = locator !== null && typeof locator === "object" && typeof locator.click === "function";
    if (!isLocator && (typeof locator !== "string" || locator.trim() === "")) throw new TypeError(`${me}: locator is a selector on the page or a Playwright Locator, got ${showValue(locator)}`);
    if (typeof done !== "function") throw new TypeError(`${me}: done is async () => truthy once the press took effect (the dialog closed), got ${typeof done}`);
    if (!Number.isInteger(retries) || retries < 0) throw new TypeError(`${me}: retries is how many more presses a "Service call error" may cost, a whole number 0 or more, got ${showValue(retries)}`);
    if (typeof backoffMs !== "number" || !Number.isFinite(backoffMs) || backoffMs < 0) throw new TypeError(`${me}: backoffMs is the ms waited after a refusal before the next press, 0 or more, got ${showValue(backoffMs)}`);
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new TypeError(`${me}: timeout is a positive number of ms, bounding each press and its outcome, got ${showValue(timeout)}`);
    if (what !== null && (typeof what !== "string" || what.trim() === "")) throw new TypeError(`${me}: what names the control in messages, a non-empty string or null, got ${showValue(what)}`);
    const control = isLocator ? locator : this.page.locator(locator).first();
    const label = `"${what ?? (isLocator ? String(locator) : locator)}"`;
    let serviceErrors = 0;
    for (;;) {
      const mark = this.toastMark();
      await control.click({ timeout });
      const deadline = now() + timeout;
      const refusal = () => ownToasts(this, mark).find((t) => t.kind === "error") ?? null;
      let refused = null;
      let checkError = null;
      for (;;) {
        refused = refusal();
        if (refused) break;
        try {
          if (await done()) return { serviceErrors };
          checkError = null;
        } catch (err) {
          checkError = err;
        }
        if (now() >= deadline) {
          refused = refusal(); // a toast that came while done() was read
          if (refused) break;
          const last = checkError ? ` (the last check: ${String(checkError?.message ?? checkError).split("\n")[0].slice(0, 200)})` : "";
          throw new Error(`${this.name}: the press of ${label} took no effect within ${timeout} ms, and no error toast came${last}`, checkError ? { cause: checkError } : undefined);
        }
        await sleep(100);
      }
      const text = String(refused.text ?? "");
      const err = Object.assign(new Error(`${this.name}: the press of ${label} was refused: the app said ${JSON.stringify(text)}`), { toast: refused });
      if (!RULES_SERVICE_ERROR_RE.test(text)) throw err;
      serviceErrors += 1;
      if (serviceErrors > retries) {
        err.serviceErrors = serviceErrors;
        err.stackCut = `${this.name}: the emulator failed a rule's get() ("Service call error") on ${serviceErrors} press(es) of ${label} in a row, so the rules never judged the write`;
        err.message = `${err.message} (${serviceErrors} press(es), each refused with "Service call error")`;
        throw err;
      }
      await sleep(backoffMs);
      // The refusals stay up (error toasts never go by themselves), stacked over the dialog's footer: clear them first.
      await this.dismissToasts();
    }
  }

  /**
   * Reply `text` in the thread quoting `quote` (thread(): a substring, or
   * null for the selected thread): the panel (openComments), that thread's
   * reply box, the text, Enter, and then the text shown in that thread.
   *
   * `timeout` (THREAD_ACTION_MS, 30 s) bounds EACH of its three waits, each
   * its own: the panel to open, the thread's reply box to press (the thread
   * listed, which for another user's thread waits on this page's snapshot),
   * and the reply to show. On a loaded stack a snapshot has taken over 30 s:
   * give it the stack's latency. Each wait that runs out throws "… within
   * <timeout> ms", which lib/test.mjs pageStall reads as a wait: "<user>: the
   * comments panel did not open within …", "<user>: reply: <thread> showed no
   * Reply box to press within … (<n> such thread(s) in the panel)" (n 0: the
   * thread never reached this page), "<user>: reply: <text> did not show in
   * <thread> within …". An empty `text` or a `timeout` that is not a
   * positive number throws before anything is pressed.
   */
  async reply(quote, text, { timeout = THREAD_ACTION_MS } = {}) {
    if (typeof text !== "string" || text === "") throw new Error(`${this.name}: reply takes a non-empty text, got ${showValue(text)}`);
    threadTimeout(this, "reply", timeout);
    await this.openComments({ timeout });
    const thread = this.thread(quote).first();
    await pressInThread(this, "reply", quote, thread.locator('textarea[placeholder="Reply"]'), "Reply box", timeout);
    await this.page.keyboard.type(text);
    await this.page.keyboard.press("Enter");
    try {
      await thread.locator(".comment-body", { hasText: text }).first().waitFor({ state: "visible", timeout });
    } catch (err) {
      if (this.page.isClosed() || !playwrightTimedOut(err)) throw err;
      throw new Error(`${this.name}: reply: ${JSON.stringify(text)} did not show in ${threadName(quote)} within ${timeout} ms`, { cause: err });
    }
  }

  /**
   * Resolve the thread quoting `quote` (null: the selected thread): the
   * panel, the thread's Resolve, then the thread gone from the list or
   * marked resolved. `timeout` (30 s) bounds EACH wait, as reply's does: the
   * panel, the Resolve button to press ("<user>: resolve: <thread> showed no
   * Resolve button to press within …"), and the outcome ("<user>: the thread
   * to resolve not reached within …").
   */
  async resolve(quote, { timeout = THREAD_ACTION_MS } = {}) {
    threadTimeout(this, "resolve", timeout);
    await this.openComments({ timeout });
    const thread = this.thread(quote).first();
    await pressInThread(this, "resolve", quote, thread.getByRole("button", { name: "Resolve" }), "Resolve button", timeout);
    // A short read: a thread that leaves the list between count() and the read would otherwise hold one poll for Playwright's 30 s.
    await this.poll(async () => (await thread.count()) === 0 || (await thread.getAttribute("data-resolved", { timeout: 1_000 })) === "true", { timeout, what: "the thread to resolve" });
  }

  /**
   * Reopen the resolved thread quoting `quote` (null: the selected thread):
   * the panel, "Show resolved" when the panel offers it, the thread's
   * Reopen, then the thread marked unresolved. `timeout` (30 s) bounds EACH
   * wait, as reply's does: the panel, the toggle, the Reopen button to press
   * (a thread this page does not yet see resolved shows Resolve instead, so
   * this waits on the snapshot too), and the outcome ("<user>: the thread to
   * reopen not reached within …").
   */
  async reopen(quote, { timeout = THREAD_ACTION_MS } = {}) {
    threadTimeout(this, "reopen", timeout);
    await this.openComments({ timeout });
    const toggle = this.page.locator(".comments-head button", { hasText: "Show resolved" });
    if (await toggle.count()) await toggle.click({ timeout });
    const thread = this.thread(quote).first();
    await pressInThread(this, "reopen", quote, thread.getByRole("button", { name: "Reopen" }), "Reopen button", timeout);
    await this.poll(async () => (await thread.getAttribute("data-resolved", { timeout: 1_000 })) === "false", { timeout, what: "the thread to reopen" });
  }

  /**
   * Press the selection toolbar's "Suggest edit" as a person does, refused
   * or not (see the header): wait until the button is the topmost element at
   * its own centre, in the same place on two reads 50 ms apart (a toast lying
   * over it for its few seconds is waited out, never clicked), then one real
   * mouse click there. Never Playwright's click, which waits for "enabled"
   * and so hangs on an aria-disabled button, and never `force`, which clicks
   * whatever is on top.
   *
   * `refused` is an expectation, when given: true wants the button
   * aria-disabled (the selection is refused), false wants it not; a mismatch
   * throws before any press. null (the default) presses either way.
   * Returns {refused (the button was aria-disabled), reason (its title, the
   * refusal's words, or null), clickedAt}. What the press did (a refusal
   * toast, the form) is for the caller to wait for.
   */
  async pressSuggest({ refused = null, timeout = 10_000 } = {}) {
    if (refused !== null && typeof refused !== "boolean") throw new Error(`${this.name}: pressSuggest refused is true, false or null, got ${JSON.stringify(refused)}`);
    const button = this.page.locator(".selection-fab", { hasText: "Suggest edit" }).first();
    const deadline = now() + timeout;
    // One Playwright step is never given less than 2 s: see openComments.
    const step = () => Math.max(deadline - now(), 2_000);
    await button.waitFor({ state: "visible", timeout });
    let probe = null;
    let prev = null;
    for (;;) {
      probe = await button.evaluate(
        (el) => {
          const view = el.ownerDocument.defaultView;
          const centre = () => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
          };
          let c = centre();
          if (c.x < 0 || c.y < 0 || c.x >= view.innerWidth || c.y >= view.innerHeight) {
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
            c = centre();
          }
          const top = el.ownerDocument.elementFromPoint(c.x, c.y);
          const d = (n) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : ""}` : "nothing");
          return { ...c, hit: top != null && (top === el || el.contains(top)), top: d(top), ariaDisabled: el.getAttribute("aria-disabled") === "true", title: el.getAttribute("title") };
        },
        undefined,
        { timeout: step() },
      );
      if (refused !== null && probe.ariaDisabled !== refused) {
        throw new Error(
          probe.ariaDisabled
            ? `${this.name}: Suggest edit is refused here (aria-disabled, ${JSON.stringify(probe.title)}), not offered`
            : `${this.name}: Suggest edit is offered here (not aria-disabled), not refused`,
        );
      }
      const steady = prev != null && Math.abs(prev.x - probe.x) < 0.5 && Math.abs(prev.y - probe.y) < 0.5;
      if (probe.hit && probe.width > 0 && probe.height > 0 && steady) break;
      if (now() >= deadline) {
        const why = probe.hit ? "it was still moving" : `the page's ${probe.top} is`;
        throw new Error(`${this.name}: Suggest edit was not the topmost element at its own centre ${JSON.stringify({ x: probe.x, y: probe.y })} within ${timeout} ms (${why}); nothing was pressed`);
      }
      prev = probe;
      await sleep(50);
    }
    await this.page.mouse.click(probe.x, probe.y);
    return { refused: probe.ariaDisabled, reason: probe.title, clickedAt: { x: probe.x, y: probe.y } };
  }

  /**
   * The floating suggestion form as it stands, read in one go: `{open: false}`
   * while there is none, else {open: true, quote, value, start, end, focused,
   * hint, note, submitDisabled}. `start` and `end` are the field's selection
   * (equal: the caret), `focused` whether the field is the page's active
   * element, `hint` the line under the field, `submitDisabled` the submit
   * button's state. Waits for nothing.
   */
  async suggestState() {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.isConnected || el.getClientRects().length === 0 || getComputedStyle(el).visibility === "hidden") return { open: false };
      const field = el.querySelector("textarea");
      const submit = el.querySelector('button[type="submit"]');
      return {
        open: true,
        quote: el.querySelector(".suggest-quote")?.textContent ?? null,
        value: field ? field.value : null,
        start: field ? field.selectionStart : null,
        end: field ? field.selectionEnd : null,
        focused: field != null && document.activeElement === field,
        hint: el.querySelector(".field-hint")?.textContent.trim() ?? null,
        note: el.querySelector('input[aria-label="Note (optional)"]')?.value ?? null,
        submitDisabled: submit ? submit.disabled : null,
      };
    }, SUGGEST_POPOVER);
  }

  /**
   * Suggest a replacement for the current selection: press "Suggest edit"
   * (pressSuggest({refused: false}), so a refused selection throws with its
   * reason rather than hanging), wait for the form, put the replacement in
   * its field, press Enter and wait for the form to close. An error toast
   * throws "suggestion refused: <text>" as soon as it shows, with `toast`
   * and `response`: the page's latest POST /suggestion entry since the
   * press (as findResponses gives it), or null when the page sent none, as
   * for a refusal the form makes itself. So Hosting's cut-off 504 behind the
   * toast is the stack not answering (lib/test.mjs stackDidNotAnswer, and
   * untilLanded sends it again), and any other answer the product's refusal.
   *
   * By default the field is filled (Playwright fill). `keyboard: true` types
   * as a person does, from wherever the form put the caret: Backspace over
   * the end of the prefilled text that differs from the replacement, then the
   * rest key by key (and the note typed into its own field). It needs the
   * field focused, and it throws BEFORE Enter, sending nothing, when the field
   * does not then hold exactly the replacement, as when the caret did not
   * start at the end. A line break or tab cannot be typed into the one-line
   * field (Enter submits), so keyboard mode refuses one; paste with
   * page.keyboard.insertText in your own steps.
   *
   * Resolves {opened (suggestState() as the form opened; in keyboard mode
   * once its field had focus), value (the field as Enter was pressed),
   * response (the page's POST /suggestion entry, as findResponses gives it,
   * or null)}.
   */
  async suggest(replacement, { note = null, keyboard = false, timeout = 20_000 } = {}) {
    if (typeof replacement !== "string") throw new Error(`${this.name}: suggest wants a replacement string, got ${typeof replacement}`);
    if (keyboard && /[\r\n\t]/.test(`${replacement}${note ?? ""}`)) {
      throw new Error(`${this.name}: suggest {keyboard: true} cannot type a line break or tab (Enter submits the one-line field); paste it with page.keyboard.insertText`);
    }
    const since = this.toastMark();
    const mark = this.responseMark();
    await this.pressSuggest({ refused: false, timeout });
    const pop = this.page.locator(SUGGEST_POPOVER).first();
    const field = pop.locator("textarea").first();
    await field.waitFor({ state: "visible", timeout });
    let opened = await this.suggestState();
    if (keyboard) {
      // The form focuses its field in an effect, a moment after it shows.
      opened = await this.poll(
        async () => {
          const s = await this.suggestState();
          return s.open && s.focused ? s : null;
        },
        { timeout: Math.min(5_000, timeout), what: "the suggestion field to take focus" },
      ).catch(async () => {
        throw new Error(`${this.name}: the suggestion form opened without focus in its field, so keystrokes would go elsewhere: ${JSON.stringify(await this.suggestState())}`);
      });
      const was = opened.value ?? "";
      let keep = 0;
      while (keep < was.length && keep < replacement.length && was[keep] === replacement[keep]) keep += 1;
      for (let i = keep; i < was.length; i += 1) await this.page.keyboard.press("Backspace");
      if (replacement.length > keep) await this.page.keyboard.type(replacement.slice(keep));
      const typed = await this.suggestState();
      if (typed.value !== replacement) {
        throw new Error(
          `${this.name}: typed at the caret, the suggestion field holds ${JSON.stringify(typed.value)}, not ${JSON.stringify(replacement)} ` +
            `(it opened holding ${JSON.stringify(was)}, selection ${opened.start}–${opened.end}); nothing was sent`,
        );
      }
      if (note) {
        await pop.locator('input[aria-label="Note (optional)"]').click();
        await this.page.keyboard.type(note);
      }
    } else {
      await field.fill(replacement);
      if (note) await pop.locator('input[aria-label="Note (optional)"]').fill(note);
    }
    const value = (await this.suggestState()).value;
    if (keyboard) await this.page.keyboard.press("Enter");
    else await field.press("Enter");
    const deadline = now() + timeout;
    for (;;) {
      const err = ownToasts(this, since).find((t) => t.kind === "error");
      if (err) throw await suggestRefusal(this, err, mark);
      if ((await pop.count()) === 0 || !(await pop.isVisible())) break;
      if (now() >= deadline) throw new Error(`${this.name}: the suggestion popover to close not reached within ${timeout} ms`);
      await sleep(100);
    }
    const response = await this.waitForResponse(SUGGESTION_POST, { since: mark, timeout: SUGGEST_ANSWER_MS }).catch(() => null);
    return { opened, value, response };
  }

  /**
   * The viewer's More menu as it stands, read in one go (see the header):
   * {groups: [{heading, items: [{label, disabled, reason}]}], labels}.
   * `heading` is null for items under no heading, `reason` an item's title (a
   * disabled item's explanation) or null, and `labels` every item's label in
   * order. Opens the menu if it is closed, and leaves it closed.
   */
  async moreMenu({ timeout = 15_000 } = {}) {
    let groups = null;
    try {
      await openMoreMenu(this, timeout);
      groups = await this.page.evaluate(readMoreMenu, MORE_MENU);
    } finally {
      await closeMoreMenu(this, timeout).catch(() => undefined);
    }
    if (!groups) throw new Error(`${this.name}: the More menu closed before it could be read`);
    return { groups, labels: groups.flatMap((g) => g.items.map((i) => i.label)) };
  }

  /**
   * The labels of the More menu's items under `heading` (".menu-label", such
   * as "Download" or "Versions"), in order, up to the next separator or
   * heading; null when the menu has no such heading, [] when it has nothing
   * under it. Leaves the menu closed.
   */
  async menuGroup(heading, { timeout = 15_000 } = {}) {
    if (typeof heading !== "string" || heading === "") throw new Error(`${this.name}: menuGroup takes a heading, got ${JSON.stringify(heading)}`);
    const { groups } = await this.moreMenu({ timeout });
    const group = groups.find((g) => g.heading === heading);
    return group ? group.items.map((i) => i.label) : null;
  }

  /**
   * Choose the item labelled exactly `label` in the More menu (opening it
   * unless it is open) and wait for the menu to close. An item that is not
   * there throws with what the menu offers; a disabled one throws with its
   * reason, and neither is pressed (Playwright's click would wait for a
   * disabled item to become enabled). Resolves the item {label, disabled,
   * reason, heading}.
   */
  async chooseMenu(label, { timeout = 15_000 } = {}) {
    if (typeof label !== "string" || label === "") throw new Error(`${this.name}: chooseMenu takes an item's label, got ${JSON.stringify(label)}`);
    const menu = await openMoreMenu(this, timeout);
    const groups = (await this.page.evaluate(readMoreMenu, MORE_MENU)) ?? [];
    const items = groups.flatMap((g) => g.items.map((i) => ({ ...i, heading: g.heading })));
    const item = items.find((i) => i.label === label);
    if (!item || item.disabled) {
      await closeMoreMenu(this, timeout).catch(() => undefined);
      if (!item) throw new Error(`${this.name}: the More menu has no "${label}" (it offers ${items.map((i) => JSON.stringify(i.label)).join(", ") || "nothing"})`);
      throw new Error(`${this.name}: "${label}" in the More menu is disabled${item.reason ? ` (${JSON.stringify(item.reason)})` : ""}`);
    }
    await menu.locator('[role="menuitem"]').filter({ hasText: exactText(label) }).first().click({ timeout });
    await menu.waitFor({ state: "detached", timeout });
    return item;
  }

  /**
   * Capture one browser download: `action` is a More-menu label (chosen with
   * chooseMenu) or a function that starts the download. Resolves {filename
   * (the browser's suggested name), bytes (a Buffer), url}. Throws when the
   * download failed, when none started within `timeout`, and, at once, when
   * the app showed an error toast instead (the app's own message, such as
   * "Could not fetch the document (500).").
   */
  async download(action, { timeout = 30_000 } = {}) {
    if (typeof action !== "string" && typeof action !== "function") {
      throw new Error(`${this.name}: download takes a More-menu label or a function that starts the download, got ${action === null ? "null" : typeof action}`);
    }
    const what = typeof action === "string" ? `"${action}"` : "the action";
    const since = this.toastMark();
    let settled = null;
    void this.page.waitForEvent("download", { timeout }).then(
      (dl) => (settled = { dl }),
      (err) => (settled = { err }),
    );
    if (typeof action === "string") await this.chooseMenu(action, { timeout: Math.min(timeout, 15_000) });
    else await action();
    while (!settled) {
      const err = ownToasts(this, since).find((t) => t.kind === "error");
      if (err) throw Object.assign(new Error(`${this.name}: no download from ${what}: the app said ${JSON.stringify(err.text)}`), { toast: err });
      await sleep(50);
    }
    if (settled.err) {
      const seen = ownToasts(this, since).map((t) => `${t.kind}: ${t.text}`).join(" | ") || "none";
      throw new Error(`${this.name}: no download from ${what} within ${timeout} ms (toasts: ${seen})`);
    }
    const { dl } = settled;
    const failure = await dl.failure();
    if (failure) throw new Error(`${this.name}: the download from ${what} failed: ${failure}`);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return { filename: dl.suggestedFilename(), bytes: Buffer.concat(chunks), url: dl.url() };
  }

  /**
   * Capture what the app hands to print() (see the header): arm a recorder
   * in the app's window, run `action` (a More-menu label, chosen with
   * chooseMenu, or a function that starts the print), and resolve once at
   * least `frames` iframes were added and every one added has had its print()
   * called. Nothing is printed and no dialog opens.
   *
   * Resolves {armedAt, frames: [{index, t, sandbox, className, src, printed,
   * hooks, hookError, snaps: [{t, html, title, url, error, extra,
   * extractError}]}]}: one row per iframe added while armed, in order (the
   * reading frame never); `sandbox`, `className` and `src` its attributes as
   * it was added; `printed` how many times print() was called (the first
   * PRINT_MAX_SNAPS are snapshotted); `hooks` how many times the recorder was
   * installed; `hookError` why it could not be (null once it was). A snapshot
   * is the frame's document at the call: `html` its doctype and outerHTML,
   * `t` the page's Date.now(). `extract`, a function of (document, arg) written
   * in the spec, runs in the page at the call and its result is `extra`; it
   * is sent as source, so it may use nothing from the spec's scope but `arg`
   * (JSON). Throws when the app showed an error toast instead, when the page
   * navigated, and when `timeout` passed (with what was recorded, as
   * `err.record`). The recorder is disarmed when it resolves or throws.
   *
   * `match`, a CSS selector, narrows what counts as a print frame: an iframe
   * added that does not match it (the owner's thumbnail capture frame,
   * app/src/viewer/capture.ts, sandboxed `allow-same-origin` alone, which a
   * loaded page may add in the middle of a print) is never hooked and is no
   * row: it is listed in the record's `ignored` ([{t, sandbox, className,
   * src}]) and waited for by nothing. For the app's print frame,
   * `'[sandbox~="allow-modals"]'`. Without it, every iframe counts, as
   * before. A selector the page cannot parse throws before anything runs.
   */
  async capturePrint(action, { timeout = 15_000, frames = 1, extract = null, arg = null, match = null } = {}) {
    if (typeof action !== "string" && typeof action !== "function") {
      throw new Error(`${this.name}: capturePrint takes a More-menu label or a function that starts the print, got ${action === null ? "null" : typeof action}`);
    }
    if (!Number.isInteger(frames) || frames < 1) throw new Error(`${this.name}: capturePrint frames is a positive integer, got ${showValue(frames)}`);
    if (extract !== null && typeof extract !== "function") throw new Error(`${this.name}: capturePrint extract is a function of (document, arg) or null, got ${typeof extract}`);
    if (match !== null && (typeof match !== "string" || match.trim() === "")) throw new Error(`${this.name}: capturePrint match is a CSS selector a print frame matches, or null, got ${showValue(match)}`);
    let argJson;
    try {
      argJson = JSON.stringify(arg ?? null);
    } catch (e) {
      throw new Error(`${this.name}: capturePrint arg must be JSON: ${e.message}`);
    }
    const what = typeof action === "string" ? `"${action}"` : "the action";
    const page = this.page;
    if (match !== null) {
      const bad = await page.evaluate((sel) => {
        try {
          document.createDocumentFragment().querySelector(sel);
          return null;
        } catch (e) {
          return String(e?.message ?? e);
        }
      }, match);
      if (bad !== null) throw new Error(`${this.name}: capturePrint match ${showValue(match)} is not a selector the page can use: ${bad}`);
    }
    const cfg = JSON.stringify({ key: PRINT_KEY, exclude: DOC_FRAME, maxSnaps: PRINT_MAX_SNAPS, match });
    await page.evaluate(`(${printRecorder.toString()})(${cfg}, ${extract ? functionSource(extract, `${this.name}: capturePrint extract`) : "null"}, ${argJson})`);
    const since = this.toastMark();
    const deadline = now() + timeout;
    const record = () => page.evaluate((key) => window[Symbol.for(key)]?.rec ?? null, PRINT_KEY);
    try {
      if (typeof action === "string") await this.chooseMenu(action, { timeout: Math.min(timeout, 15_000) });
      else await action();
      for (;;) {
        // A navigation in flight destroys the context mid-read: read again on the next turn.
        const p = await page.evaluate(printProgress, PRINT_KEY).catch((e) => (page.isClosed() ? Promise.reject(e) : undefined));
        if (p === undefined) {
          if (now() >= deadline) throw new Error(`${this.name}: no print from ${what} within ${timeout} ms: the page could not be read (navigating?)`);
          await sleep(100);
          continue;
        }
        if (p === null) throw new Error(`${this.name}: the page navigated during capturePrint(${what}), and its print recorder went with it`);
        if (p.frames >= frames && p.unprinted === 0) break;
        const err = ownToasts(this, since).find((t) => t.kind === "error");
        if (err) throw Object.assign(new Error(`${this.name}: no print from ${what}: the app said ${JSON.stringify(err.text)}`), { toast: err });
        if (now() >= deadline) {
          const rec = await record().catch(() => null);
          const ignored = p.ignored ? `; ${p.ignored} iframe(s) not matching ${match} ignored` : "";
          throw Object.assign(new Error(`${this.name}: no print from ${what} within ${timeout} ms: ${p.frames} frame(s) added (${frames} wanted) ${JSON.stringify(p.rows)}${ignored}`), { record: rec });
        }
        await sleep(100);
      }
      return await record();
    } finally {
      if (!page.isClosed()) await page.evaluate((key) => window[Symbol.for(key)]?.disarm?.(), PRINT_KEY).catch(() => undefined);
    }
  }

  /** A DOM excerpt for evidence: what a person would need to see to judge the state. */
  async domExcerpt({ frameChars = 20_000 } = {}) {
    if (this.closed || this.page.isClosed()) return { closed: true };
    return this.page.evaluate(
      ({ sel, frameChars }) => {
        const buttons = (root) =>
          Array.from(document.querySelectorAll(`${root} button, ${root} [role="button"], ${root} select, ${root} input`)).map((b) => ({
            label: b.getAttribute("aria-label") || b.textContent.trim().slice(0, 60),
            disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
            title: b.getAttribute("title") || undefined,
          }));
        const el = document.querySelector(sel);
        let frame = null;
        try {
          const d = el?.contentDocument;
          frame = d?.body ? { url: d.location.href, bodyAttrs: d.body.getAttributeNames().map((n) => `${n}=${d.body.getAttribute(n)}`), body: d.body.outerHTML.slice(0, frameChars), truncated: d.body.outerHTML.length > frameChars } : null;
        } catch (e) {
          frame = { error: String(e) };
        }
        return {
          url: location.href,
          title: document.title,
          viewerToolbar: buttons(".viewer-toolbar"),
          editToolbar: buttons(".edit-toolbar"),
          shareState: document.querySelector(".share-state")?.getAttribute("data-state") ?? null,
          saveState: document.querySelector(".save-state")?.textContent ?? null,
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((a) => a.textContent.trim()),
          toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent.trim()),
          iframe: el ? { src: el.getAttribute("src"), sandbox: el.getAttribute("sandbox"), style: el.getAttribute("style") } : null,
          frame,
        };
      },
      { sel: DOC_FRAME, frameChars },
    );
  }

  /**
   * A tab (newTab): close its page alone (Playwright's page.close(), which
   * runs no beforeunload). The user the context was made for: close the
   * context, and so every tab of it, each then `closed` too.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tabOf) {
      await this.page?.close().catch(() => undefined);
      return;
    }
    for (const t of this.tabs) t.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

/**
 * A pool of signed-in users. Lazily launches ceil(N / usersPerBrowser) Chrome
 * processes; every user gets its own context and page, with the tripwire,
 * the toast observer and console/request capture installed before the first
 * navigation.
 */
export class BrowserPool {
  constructor({ target, usersPerBrowser = 5, headless = true, trace = process.env.E2E_TRACE === "1" } = {}) {
    if (!target) throw new Error("BrowserPool needs a target");
    // A Playwright trace stores Cookie/Set-Cookie headers, ID tokens, token
    // bodies and the passwords typed into forms, unredacted (evidence.mjs
    // cannot reach inside the zip): never on anything but a local stack.
    if (trace && target.kind !== "local") {
      const err = new Error(`E2E_TRACE is refused on a ${target.kind} target: a trace holds cookies, tokens and passwords unredacted`);
      err.code = "E2E_TRACE_REFUSED";
      throw err;
    }
    this.target = target;
    this.usersPerBrowser = usersPerBrowser;
    this.headless = headless;
    this.trace = trace;
    this.browsers = []; // {promise, contexts}
    this.users = [];
    this.via = null;
    this.version = null;
    this.parserPage = null;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.memoryGated = false; // the pool's base (E2E_POOL_BASE_GB) was asked for once
    this.prepaid = 0; // contexts many() already asked memory for
  }

  /**
   * Wait until the machine has room for `contexts` more contexts (see the
   * header): the pool's base the first time, E2E_POOL_CONTEXT_MB (600) each. Throws
   * E2E_INCONCLUSIVE when it never does within poolWaitMs().
   */
  async admitContexts(contexts) {
    const thresholds = memoryThresholds();
    const need = poolNeedBytes(contexts, { withBase: !this.memoryGated, thresholds });
    const dir = process.env.E2E_INVOCATION_DIR;
    const r = await waitForMemory({
      need: { minAvailableBytes: need },
      sample: () => sampleMemory({ windowMs: 0 }),
      gate: "browser-pool",
      timeoutMs: poolWaitMs(),
      logFile: dir ? `${dir}/load.jsonl` : null,
      detail: { contexts, base: !this.memoryGated, pid: process.pid },
    });
    if (!r.ok) {
      const base = `${Number((thresholds.poolBaseBytes / GIB).toFixed(1))} GB + `;
      const each = `${Math.round(thresholds.poolContextBytes / 1024 ** 2)} MB`;
      const err = new Error(`INCONCLUSIVE: the machine never had room for ${contexts} more browser context(s) in ${Math.round(r.waitedMs / 1000)} s: it needs ${(need / GIB).toFixed(1)} GB available (${this.memoryGated ? "" : base}${contexts} × ${each}), and has ${(r.sample.availableBytes / GIB).toFixed(1)} GB`);
      err.code = "E2E_INCONCLUSIVE";
      err.reason = err.message.slice("INCONCLUSIVE: ".length);
      throw err;
    }
    this.memoryGated = true;
  }

  /** The browser slot for the next context; launches are shared, never duplicated. */
  slot() {
    if (this.closing || this.closed) throw new Error("pool is closed");
    let b = this.browsers.find((x) => x.contexts < this.usersPerBrowser);
    if (!b) {
      b = {
        contexts: 0,
        promise: launchChrome({ headless: this.headless }).then((r) => {
          this.via ??= r.via;
          this.version ??= r.version;
          return r.browser;
        }),
      };
      this.browsers.push(b);
    }
    b.contexts += 1;
    return b;
  }

  /**
   * One more user, with its own context and page.
   *
   * `consent` "denied" or "granted" is a visitor who has already answered
   * the app's analytics consent banner that way: CONSENT_KEY holds it in the
   * context's localStorage for the stack's origin before the first page
   * loads (Playwright's storageState, written once as the context is made,
   * as a returning visitor's browser holds it), so on a deployment with
   * analytics the banner never lies over the page. null, the default, leaves
   * it unanswered. Nothing answers it again later: a case that removes the
   * key sees the banner, as that visitor would. Any other value throws
   * before anything is made.
   *
   * `device` {width, height, touch} is the viewport the context is made
   * with, in whole CSS px, and with `touch: true` a phone or tablet
   * (Playwright's hasTouch and isMobile: `(pointer: coarse)` and
   * `(hover: none)` match, and tap() works; see the header). null, the
   * default, is the desktop every user was before, 1280×800 with a mouse.
   * The user's `device` says which, frozen. A malformed device, or one with
   * a key it does not take, throws a TypeError before anything is made.
   */
  async user({ name = null, consent = null, device = null } = {}) {
    if (this.closing || this.closed) throw new Error("pool is closed");
    consent = checkConsent(consent, "user()");
    device = checkDevice(device, "user()");
    if (this.prepaid > 0) this.prepaid -= 1;
    else await this.admitContexts(1);
    if (this.closing || this.closed) throw new Error("pool is closed");
    // Numbered synchronously: users made concurrently (many()) must not all
    // read the same length before any of them is pushed.
    this.seq = (this.seq ?? 0) + 1;
    name ??= `u${this.seq}`;
    const slot = this.slot();
    const browser = await slot.promise;
    const context = await browser.newContext({ ...CONTEXT_OPTIONS, ...deviceOptions(device), baseURL: this.target.origin, ...(consent ? { storageState: consentStorage(this.target.origin, consent) } : {}) });
    const user = new User(this, { name, context, page: null, device });
    this.users.push(user);
    await this.instrument(user, context);
    if (this.trace) await context.tracing.start({ screenshots: true, snapshots: true });
    user.page = await context.newPage();
    if (process.env.E2E_RTDB_COVERAGE_RECYCLE === "1") await preserveFirestoreResponses(this.target, context, user.page);
    return user;
  }

  /** N users, created five at a time; `consent` and `device` are each one's, as user() takes them. */
  async many(n, { batch = 5, names = null, consent = null, device = null } = {}) {
    consent = checkConsent(consent, "many()");
    device = checkDevice(device, "many()");
    // A pool of n contexts asks for its memory once, up front.
    await this.admitContexts(n);
    this.prepaid += n;
    const out = [];
    for (let i = 0; i < n; i += batch) {
      const chunk = await Promise.all(
        Array.from({ length: Math.min(batch, n - i) }, (_, j) => this.user({ ...(names ? { name: names[i + j] } : {}), consent, ...(device === DESKTOP_DEVICE ? {} : { device }) })),
      );
      out.push(...chunk);
    }
    return out;
  }

  async instrument(user, context) {
    const target = this.target;
    if (process.env.E2E_RTDB_COVERAGE_RECYCLE === "1") observeFirestoreContext(target, context);
    const log = user.log;
    await context.exposeBinding("__e2eToast", (source, toast) => {
      // Which page showed it, for a tab's waits (ONE PERSON IN TWO TABS); never serialised.
      if (toast && typeof toast === "object") Object.defineProperty(toast, "page", { value: source?.page ?? null, enumerable: false });
      log.toasts.push(toast);
    });
    await context.addInitScript(toastObserver);
    await context.route(
      () => true,
      async (route) => {
        const req = route.request();
        const v = classifyUrl(req.url(), target, { method: req.method() });
        if (v.verdict === "allow") return route.fallback();
        const rec = { t: now(), user: user.name, method: req.method(), url: req.url(), resourceType: req.resourceType(), reason: v.reason };
        (v.verdict === "breach" ? log.breaches : v.verdict === "sdk-probe" ? log.sdkProbes : log.external).push(rec);
        return route.abort("blockedbyclient").catch(() => undefined);
      },
    );
    const started = new Map();
    // A request's row from its response until it finishes or fails: the row
    // is written at the response and completed in place (see the header).
    const answered = new WeakMap();
    context.on("request", (req) => {
      started.set(req, now());
    });
    const record = (req, extra) => {
      const t0 = started.get(req) ?? now();
      started.delete(req);
      const row = { t: t0, ms: now() - t0, method: req.method(), url: req.url(), type: req.resourceType(), ...extra };
      log.requests.push(row);
      if (log.requests.length > NETWORK_LOG_MAX) log.requests.splice(0, log.requests.length - NETWORK_LOG_MAX);
      return row;
    };
    // WHAT A PAGE CREATED: a 200 to a creating request is the run's (see the header).
    context.on("response", (res) => {
      if (res.status() !== 200) return;
      const req = res.request();
      if (req.method() !== "POST") return;
      const path = pathnameOf(req.url());
      if (path !== "/publish" && path !== "/folder" && path !== "/fork") return;
      let postJson = null;
      if (path !== "/publish") {
        try {
          postJson = jsonOrNull(req.postData());
        } catch {}
      }
      const what = pageCreation(req.method(), req.url(), postJson, target.origin);
      if (!what) return;
      const pending = ledgerCreation(user, what, res).finally(() => user.creating.delete(pending));
      user.creating.add(pending);
    });
    context.on("response", (res) => {
      const req = res.request();
      const row = record(req, { status: res.status(), finished: false });
      answered.set(req, row);
      const entry = responseEntry(user.responseCount, res, req, row.t, row.t + row.ms);
      // Which page sent it, for a tab's waits (ONE PERSON IN TWO TABS); never serialised.
      Object.defineProperty(entry, "page", { value: requestPage(req), enumerable: false });
      user.responses.push(entry);
      user.responseCount += 1;
      if (user.responses.length > NETWORK_LOG_MAX) user.responses.splice(0, user.responses.length - NETWORK_LOG_MAX);
    });
    context.on("requestfinished", async (req) => {
      const row = answered.get(req);
      if (row) {
        answered.delete(req);
        row.ms = now() - row.t;
        row.finished = true;
        return;
      }
      const res = await req.response().catch(() => null);
      record(req, { status: res ? res.status() : null, finished: true });
    });
    context.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "failed";
      const row = answered.get(req);
      if (row) {
        answered.delete(req);
        row.ms = now() - row.t;
        row.failure = failure;
        return;
      }
      record(req, { failure, finished: false });
    });
    const watchPage = (page) => {
      page.on("console", (m) => log.console.push({ t: now(), type: m.type(), text: m.text(), at: m.location()?.url }));
      page.on("pageerror", (e) => log.errors.push({ t: now(), message: e.message, stack: e.stack }));
      page.on("websocket", (ws) => {
        const v = classifyUrl(ws.url(), target);
        const rec = { t: now(), url: ws.url(), verdict: v.verdict, reason: v.reason };
        log.websockets.push(rec);
        if (v.verdict === "breach") log.breaches.push({ ...rec, user: user.name, method: "WEBSOCKET" });
        ws.on("framesent", (f) => log.wsFrames.push("sent", f.payload));
        ws.on("framereceived", (f) => log.wsFrames.push("received", f.payload));
      });
    };
    context.on("page", watchPage);
  }

  /** Every isolation breach any user hit. */
  breaches() {
    return this.users.flatMap((u) => u.log.breaches);
  }

  /** Every creation any user's page made (see WHAT A PAGE CREATED): `log.created` of every user, flattened, each with its `user`. */
  created() {
    return this.users.flatMap((u) => u.log.created.map((r) => ({ user: u.name, ...r })));
  }

  /** Every Firestore SDK network test any user's page sent (isSdkProbe): blocked, and never a breach. */
  sdkProbes() {
    return this.users.flatMap((u) => u.log.sdkProbes ?? []);
  }

  /** Throw "isolation breach" if any request left the stack. */
  assertIsolation() {
    const b = this.breaches();
    if (b.length > 0) {
      const err = new Error(`isolation breach: ${b.length} request(s) left stack ${this.target.runId}: ${b.slice(0, 5).map((x) => `${x.user} ${x.method} ${x.url} (${x.reason})`).join("; ")}`);
      err.code = "E2E_ISOLATION_BREACH";
      err.breaches = b;
      throw err;
    }
  }

  /**
   * A scratch page for parsing bytes with Chrome's DOMParser (bytes.mjs):
   * its own context, about:blank, every request aborted.
   */
  async parser() {
    if (this.parserPage && !this.parserPage.isClosed()) return this.parserPage;
    await this.admitContexts(1);
    if (this.closing || this.closed) throw new Error("pool is closed");
    const slot = this.browsers[0] ?? this.slot();
    const browser = await slot.promise;
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route(() => true, (route) => route.abort("blockedbyclient"));
    this.parserPage = await context.newPage();
    return this.parserPage;
  }

  /**
   * A scratch renderer (see the header): its own context in the pool's
   * Chrome, every request aborted (the URLs kept, per render, as `blocked`),
   * `deviceScaleFactor` device pixels per CSS pixel, `media` emulated
   * ("print", "screen" or null for none), a `width` × `height` viewport.
   * Returns {page, context, width, height, media, render(html, o), close()};
   * the pool closes it too.
   *
   * render(html, {width, height, computed, probe, stripAuthorStyles,
   * screenshot, without, regions, timeout = 30_000}) sets the viewport, loads
   * `html` (setContent, to `load`) and, in this order:
   *   stripAuthorStyles  removes every <style> and stylesheet <link>: what
   *                      elements compute to with no author CSS (inline
   *                      style attributes stay);
   *   computed           {selector, properties}: `elements`, each match as
   *                      {tag, id, className, text, rect: [x, y, w, h],
   *                      computed: {property: value}};
   *   probe              async (page) => value, your own reading: `probed`;
   *   screenshot         `png`, the viewport as PNG bytes (implied by
   *                      `without` and `regions`);
   *   without            a selector: its matches are removed (`removed` says
   *                      how many) and the viewport shot again, `basePng`;
   *   regions            {name: {x, y, w, h, color = null, tol = 70,
   *                      minDiff = 30}}: `pixels[name]` is lib/png.mjs
   *                      colourPixels over `png` in that box, counting only
   *                      what differs from `basePng` when `without` was given.
   * Before `computed` (so after `stripAuthorStyles`) the render SETTLES: it
   * waits for `document.fonts.ready` and then two animation frames, so the
   * boxes and styles read, and the probe, are those of the page as painted,
   * not of a frame before it (a stamp's box measured that early did not
   * enclose the glyphs later shot, which then counted as stray pixels). A
   * baseline screenshot settles again after `without` removes elements: a
   * browser screenshot alone does not reliably wait for subsequent animation
   * frames. `settle: false` skips these explicit waits; a page
   * that does not settle within `timeout` throws.
   * Resolves {width, height, elements, probed, removed, png, basePng, pixels,
   * blocked, settled}, each null when not asked for (`settled` is whether it
   * settled). `blocked` may hold link keys:
   * write it to evidence only through ctx.ev, which redacts.
   */
  async printRenderer({ width = PRINT_PAGE.width, height = PRINT_PAGE.height, media = "print", deviceScaleFactor = 1 } = {}) {
    if (this.closing || this.closed) throw new Error("pool is closed");
    for (const [n, v] of [["width", width], ["height", height]]) {
      if (!Number.isInteger(v) || v < 1 || v > 16_384) throw new Error(`printRenderer: ${n} is an integer from 1 to 16384, got ${showValue(v)}`);
    }
    if (!RENDER_MEDIA.includes(media)) throw new Error(`printRenderer: media is "print", "screen" or null, got ${showValue(media)}`);
    if (!(typeof deviceScaleFactor === "number" && deviceScaleFactor > 0 && deviceScaleFactor <= 4)) throw new Error(`printRenderer: deviceScaleFactor is a number above 0, at most 4, got ${showValue(deviceScaleFactor)}`);
    await this.admitContexts(1);
    if (this.closing || this.closed) throw new Error("pool is closed");
    const slot = this.browsers[0] ?? this.slot();
    const browser = await slot.promise;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, serviceWorkers: "block", reducedMotion: "reduce" });
    (this.renderContexts ??= []).push(context);
    const blocked = [];
    await context.route(
      () => true,
      (route) => {
        if (blocked.length < RENDER_BLOCKED_MAX) blocked.push(route.request().url());
        return route.abort("blockedbyclient").catch(() => undefined);
      },
    );
    const page = await context.newPage();
    await page.emulateMedia({ media });
    const dims = { width, height };
    const render = async (html, { width: w = dims.width, height: h = dims.height, computed = null, probe = null, stripAuthorStyles = false, screenshot = false, without = null, regions = null, settle = true, timeout = 30_000 } = {}) => {
      if (typeof html !== "string") throw new Error(`printRenderer render: html is a string, got ${typeof html}`);
      if (typeof settle !== "boolean") throw new Error(`printRenderer render: settle is true or false, got ${showValue(settle)}`);
      if (computed !== null && !(computed && typeof computed.selector === "string" && Array.isArray(computed.properties) && computed.properties.length > 0 && computed.properties.every((p) => typeof p === "string"))) {
        throw new Error(`printRenderer render: computed is {selector, properties: [names]} or null, got ${showValue(computed)}`);
      }
      if (probe !== null && typeof probe !== "function") throw new Error(`printRenderer render: probe is async (page) => value or null, got ${typeof probe}`);
      if (without !== null && (typeof without !== "string" || without.trim() === "")) throw new Error(`printRenderer render: without is a selector or null, got ${showValue(without)}`);
      const boxes = renderRegions(regions);
      for (const [n, v] of [["width", w], ["height", h]]) {
        if (!Number.isInteger(v) || v < 1 || v > 16_384) throw new Error(`printRenderer render: ${n} is an integer from 1 to 16384, got ${showValue(v)}`);
      }
      await page.setViewportSize({ width: w, height: h });
      const from = blocked.length;
      await page.setContent(html, { waitUntil: "load", timeout });
      if (stripAuthorStyles) await page.evaluate(() => document.querySelectorAll('style, link[rel~="stylesheet"]').forEach((el) => el.remove()));
      if (settle) await settleRender(page, timeout);
      const elements = computed ? await page.evaluate(readComputed, { selector: computed.selector, properties: computed.properties }) : null;
      const probed = probe ? await probe(page) : null;
      let png = null;
      let basePng = null;
      let removed = null;
      let pixels = null;
      if (screenshot || without || boxes) {
        png = await page.screenshot({ type: "png", timeout });
        if (without) {
          removed = await page.evaluate((sel) => {
            const els = document.querySelectorAll(sel);
            els.forEach((el) => el.remove());
            return els.length;
          }, without);
          if (settle) await settleRender(page, timeout);
          basePng = await page.screenshot({ type: "png", timeout });
        }
        if (boxes) {
          const img = pngPixels(png);
          const base = basePng ? pngPixels(basePng) : null;
          pixels = Object.fromEntries(boxes.map(([name, b]) => [name, colourPixels(img, { ...b, baseline: base })]));
        }
      }
      return { width: w, height: h, elements, probed, removed, png, basePng, pixels, blocked: blocked.slice(from), settled: settle };
    };
    return { page, context, width, height, media, render, close: () => context.close().catch(() => undefined) };
  }

  stats() {
    return { browsers: this.browsers.length, users: this.users.length, via: this.via, version: this.version };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; // reject new contexts immediately, but do not claim quiescence
    this.closePromise = Promise.resolve().then(async () => {
      try {
        await Promise.allSettled(this.users.map((u) => u.close()));
        await Promise.allSettled((this.renderContexts ?? []).map((c) => c.close()));
      } finally {
        // A failed context close must not strand any browser. Every caller awaits
        // this same completion, including a second close during timeout cleanup.
        const results = await Promise.allSettled(this.browsers.map(async (b) => {
          const browser = await b.promise.catch(() => null);
          await browser?.close();
        }));
        const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
        if (errors.length) throw new AggregateError(errors, "browser shutdown failed");
        this.closed = true;
        this.closing = false;
      }
    });
    return this.closePromise;
  }
}

/** Sign users in through the UI, `batch` at a time (5 by default, as the plan's scale budget assumes). */
export async function signInMany(users, accounts, { batch = 5 } = {}) {
  const out = [];
  for (let i = 0; i < users.length; i += batch) {
    out.push(...(await Promise.all(users.slice(i, i + batch).map((u, j) => u.signInUi(accounts[i + j].email, accounts[i + j].password)))));
  }
  return out;
}

/**
 * The path a local cross-site page opens on the stack's Hosting: a static
 * file of the app, so no app boots there. Any path would do (Hosting answers
 * an unknown one with the app's shell, which then boots: slower, and noisy).
 */
export const CROSS_SITE_PATH = "/llms.txt";

/** What a route cross-site page is: a document that fetches nothing (its icon is inline). */
const CROSS_SITE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>e2e cross-site page</title><link rel="icon" href="data:,"></head>' +
  "<body><p>A page on another site, made by the e2e harness. Nothing on it was fetched.</p></body></html>";

/**
 * Put `user`'s page on an origin that is CROSS-SITE to the target, and return
 * that origin; a request the page then sends to the target is labelled
 * `Sec-Fetch-Site: cross-site` by the browser and carries that `Origin`.
 *
 * `via: "stack"` (the default on a local target) opens `path` on the stack's
 * own Hosting port under the other loopback name: `http://localhost:<port>`
 * for a stack on 127.0.0.1 (or the reverse). `via: "route"` (the default on
 * any other target) opens `https://e2e-<8 hex>.example<path>`, answered by a
 * route on the page itself: every navigation there gets a small page, every
 * other request a 404, and nothing reaches the network. See the header for
 * why a route page is no use for testing a LOCAL stack. Throws when the page
 * did not end up on that origin.
 *
 * @returns {Promise<string>} the page's origin
 */
export async function openCrossSitePage(user, { path = CROSS_SITE_PATH, via, timeout = 30_000 } = {}) {
  const page = user?.page;
  const target = user?.target;
  if (!page || !target || typeof page.goto !== "function") throw new TypeError("openCrossSitePage(user): a User of a BrowserPool");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new TypeError(`openCrossSitePage: path is a pathname such as "${CROSS_SITE_PATH}", not ${JSON.stringify(path)}`);
  via ??= target.kind === "local" ? "stack" : "route";
  let origin;
  if (via === "stack") {
    if (target.kind !== "local") throw new Error(`openCrossSitePage: via "stack" opens the stack's own Hosting under its other loopback name, and a ${target.kind} target has none: use via "route"`);
    const o = new URL(target.origin);
    const other = { "127.0.0.1": "localhost", localhost: "127.0.0.1" }[o.hostname];
    if (!other) throw new Error(`openCrossSitePage: the stack's origin ${o.origin} is on neither 127.0.0.1 nor localhost, so there is no other loopback name for it`);
    o.hostname = other;
    origin = o.origin;
  } else if (via === "route") {
    origin = `https://e2e-${randomBytes(4).toString("hex")}.example`;
    const at = origin;
    await page.route(
      (u) => u.origin === at,
      (route) => {
        const answer = route.request().isNavigationRequest()
          ? { status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: CROSS_SITE_PAGE }
          : { status: 404, contentType: "text/plain", body: "not here" };
        return route.fulfill(answer).catch(() => undefined);
      },
    );
  } else {
    throw new TypeError(`openCrossSitePage: via is "stack" or "route", not ${JSON.stringify(via)}`);
  }
  await page.goto(`${origin}${path}`, { waitUntil: "load", timeout });
  const landed = await page.evaluate(() => location.origin);
  if (landed !== origin) throw new Error(`openCrossSitePage: the page is on ${landed}, not ${origin}`);
  return origin;
}
