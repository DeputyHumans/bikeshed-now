// SPDX-License-Identifier: Apache-2.0
// The document viewer: composition only (SPEC §6, §6a, §6c, §16, §17).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth";
import { signingInLabel } from "../components/AddressNotice";
import { logEvent } from "../analytics";
import { createAnnotation, formatRelative, listAnnotations, listMyFolders, listMyTeams } from "../firestore";
import { describeAnchorFromRange, describeAnchorFromSelection } from "../annotation/anchor";
import { applySuggestion, resolveSuggestion, trimToText } from "../annotation/exact";
import { Sidebar } from "../annotation/Sidebar";
import { commitVersion, publishSaved, UnresolvedCommentsError, StaleVersionError } from "../edit";
import { downloadEntry, downloadSource, downloadZip } from "../export/html";
import { printDoc } from "../export/pdf";
import { MARKING_OFF } from "../export/labels";
import { useCoarsePointer, useIsPhone, useIsSingleColumn } from "../hooks/useMediaQuery";

import { useDocument } from "../viewer/useDocument";
import { useDocumentTitle } from "../viewer/useDocumentTitle";
import { useDocFrame } from "../viewer/useDocFrame";
import { useAnnotationLayer } from "../viewer/useAnnotationLayer";
import { useInlineEditor } from "../viewer/useInlineEditor";
import { useSharedDocument } from "../viewer/useSharedDocument";
import { useEditSession } from "../viewer/useEditSession";
import { refusesListeners } from "../viewer/frameWatch";
import { useDocTrust } from "../viewer/useDocTrust";
import { usePresenting } from "../viewer/usePresenting";
import { useCommentsOpen } from "../viewer/useCommentsOpen";
import { useDeck } from "../viewer/useDeck";
import { useFrameFit } from "../viewer/useFrameFit";
import { useThumbCapture } from "../viewer/useThumbCapture";
import { captureNeeds, storedSlideImages } from "../thumbs";
import { isExpired } from "../expiry";
import { isTrashed } from "../trash";
import { restoreItem, trashItem } from "../folders";
import { useReadingSession } from "../viewer/useReadingSession";
import { usePeerPresence } from "../viewer/usePeerPresence";
import { useLiveSync } from "../viewer/useLiveSync";
import { useFork, useLineage } from "../viewer/useFork";
import { usePrinting } from "../viewer/usePrinting";
import { useVersionDrop } from "../viewer/useVersionDrop";
import { contentBase, readsDraft, type FrameMode } from "../viewer/frameMode";

import { EditToolbar } from "../wysiwyg/EditToolbar";
import { ViewerToolbar } from "../components/ViewerToolbar";
import { ViewerBanners } from "../components/ViewerBanners";
import { SelectionFab } from "../components/SelectionFab";
import { SuggestPopover, popoverPosition, type PopoverPosition } from "../components/SuggestPopover";
import { acceptSuggestion, claimSuggestion, rejectSuggestion, releaseSuggestion, suggestEdit } from "../suggestions";
import { ReviewBar } from "../components/ReviewBar";
import {
  acceptInSession,
  followingSuggestion,
  passEndNotice,
  publishBlockedReason,
  useSuggestionReview,
} from "../viewer/useSuggestionReview";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import { SlidePanel } from "../components/SlidePanel";
import { SlideOverview } from "../components/SlideOverview";
import { SharePanel } from "../components/SharePanel";
import { TrustDialog } from "../components/TrustDialog";
import { MarkingDialog } from "../components/MarkingDialog";
import { StatsPanel } from "../components/StatsPanel";
import { DetailsPanel } from "../components/DetailsPanel";
import { readingMinutes, wordsOf } from "../readingTime";
import { ForksPanel } from "../components/ForksPanel";
import { ImageExportDialog } from "../components/ImageExportDialog";
import { UploadVersionDialog, versionUploadMessage } from "../components/UploadVersionDialog";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Spinner";
import { NotHere } from "../components/NotHere";
import { useToast } from "../components/Toast";
import { visibilityStateOf } from "../visibility";
import type { MenuEntry } from "../components/Menu";
import type { Anchor, Annotation, FolderMeta, TeamMeta } from "../types";
import { canSuggestDoc, isApprover, isDocEditor as isDocEditorOf, offersSuggest, offersVersionUpload } from "../roles";

/**
 * This file is COMPOSITION. Every decision lives in a hook in `viewer/`, and
 * what remains here is which hooks exist and what they are wired to.
 *
 * The declaration order below is load-bearing, not stylistic. Every hook that
 * puts something INTO the document must be declared before `useInlineEditor`.
 * Within one component, effect cleanups run in declaration order before any
 * setup, so their cleanups have already run by the time the editor attaches.
 *
 * Today that is two of them, and both matter:
 *   `useAnnotationLayer`  strips every highlight and the injected stylesheet
 *   `usePeerPresence`     removes the peer overlay and its stylesheet
 *
 * Presence was originally declared AFTER the editor, and its overlay reached
 * edit mode in a real browser: its cleanup ran after the editor's setup, so the
 * peer layer was still in the document the editor attached to.
 *
 * What actually prevents that now is leg 1 — `usePeerPresence` does not create
 * the overlay at all while this reader is editing, so there is nothing to tear
 * down and the ordering cannot matter. This order is the belt to that braces,
 * kept because the next hook to inject something will be written by somebody
 * reading this list rather than that guard.
 *
 * This is leg 2 of the four defences that keep decoration out of published
 * bytes; legs 1, 3 and 4 are in the hooks and the serializer.
 *
 * `useDeck` is deliberately NOT in that list. It scrolls the document and
 * measures it and writes nothing to it, so it has no cleanup the editor could
 * race. If it ever injects a node, a class or an attribute, it moves above
 * `useInlineEditor` and into `viewer/invariant.test.tsx`'s harness. The same
 * holds for `useThumbCapture`, which reads the document to build previews and
 * renders them in a frame of its own.
 *
 * Nor is `useVersionDrop`. It listens to the document for a file dragged into
 * it and writes nothing there: the target it raises is the page's, over the
 * frame, never in it.
 */

type Dialog =
  | null
  | "share"
  | "trust"
  | "marking"
  | "stats"
  | "details"
  | "forks"
  | "image"
  | "upload-version";

export function DocViewer() {
  const { docId = "", versionId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, emailLower, gate, movingTo } = useAuth();
  const singleColumn = useIsSingleColumn();
  const phone = useIsPhone();
  // Touch: the selection controls and the suggestion form dock at the bottom (SelectionFab).
  const coarsePointer = useCoarsePointer();
  const signedIn = gate === "ready" && Boolean(user);
  const linkKey = params.get("k") ?? "";

  const doc = useDocument(docId, versionId, {
    k: linkKey,
    uid: signedIn && user ? user.uid : null,
    settled: gate !== "loading",
  });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsUnreadable, setAnnotationsUnreadable] = useState(false);
  const [teams, setTeams] = useState<TeamMeta[]>([]);
  // Only for the breadcrumb. An anonymous reader of a public document has no
  // folders and gets a trail of one, which is correct: "Everything" is still
  // where the workspace is if they sign in.
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // A file dropped onto the document, waiting in the upload dialog.
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const currentLiveEpoch = doc.meta?.liveEpoch ?? doc.publicDoc?.liveEpoch ?? "initial";
  const { origin: editingOrigin, error: editOpenError, setEditing: setWantsEdit, reloadEditing } = useEditSession(docId, doc.currentVersion);
  const wantsEdit = editingOrigin !== null;
  // Both wait on the server with nothing else on screen changing, and both
  // would act twice on a second press.
  const [commenting, setCommenting] = useState(false);
  const [committing, setCommitting] = useState(false);
  // Collapsed until the first snapshot says there is a thread to read.
  const {
    open: commentsOpen,
    setOpen: setCommentsOpen,
    settle: settleComments,
  } = useCommentsOpen(docId);
  const [pane, setPane] = useState<"doc" | "comments">("doc");
  const { presenting, start: startPresenting, stop: stopPresenting } = usePresenting();
  const [railOpen, setRailOpen] = useState(true);
  const [pendingComment, setPendingComment] = useState(false);
  // The suggestion being written: what it quotes, and where its form floats.
  const [suggesting, setSuggesting] = useState<{ version: string; anchor: Anchor; position: PopoverPosition } | null>(null);
  // The approver's review pass, and which suggestion it is on (SPEC §22).
  const [review, setReview] = useState<{ currentId: string | null } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  const isOwner = doc.meta?.ownerEmail === emailLower;
  const isDocEditor = isDocEditorOf(doc.meta, emailLower);
  // Open editing widens WHO, never to anyone: a signed-in account is still
  // required, on every document, whatever its owner chose.
  const headVersion = doc.meta?.currentVersion ?? doc.publicDoc?.currentVersion ?? "";
  const isCurrent = Boolean(headVersion) && doc.currentVersion === headVersion;
  // A reader who came through a folder's link or public level reads, and
  // nothing else: the rules hold no grant for them, so no thread, no presence
  // and no edit is theirs, signed in or not (SPEC §17 "A folder's reach").
  const throughFolder = !doc.meta && doc.publicDoc?.viaFolder === true;
  // In the Trash only its owner reads it, and nobody writes it, until it is
  // restored: expiry's rule, which the server applies to both (SPEC §4).
  const trashed = isTrashed(doc.meta);
  const frozen = trashed || isExpired(doc.meta?.expiresAt);
  const canWrite = isCurrent && !frozen && !throughFolder;
  const canEdit = canWrite && (isDocEditor || (signedIn && doc.publicEdit));
  // The real editor set, as the server asks of an upload (SPEC §2).
  const offersUpload = canWrite && offersVersionUpload(doc.meta, emailLower);

  // The member record, or the projection a public or link reader gets: either
  // says whether this is a fork, and neither says of what (SPEC §21).
  const forked = doc.meta?.forked ?? doc.publicDoc?.forked ?? false;
  // A reader on an old version forks THAT one: what they see is what they get.
  const forkVersion =
    doc.currentVersion && headVersion && doc.currentVersion !== headVersion
      ? doc.currentVersion
      : undefined;
  const { fork, forking } = useFork(docId, {
    versionId: forkVersion,
    linkKey,
    uid: signedIn && user ? user.uid : null,
    resolvedFor: doc.resolvedFor,
  });
  const lineage = useLineage(docId, {
    linkKey,
    ready: signedIn && Boolean(user) && doc.resolvedFor === user?.uid,
    auto: forked,
  });

  const trust = useDocTrust({
    docId,
    uid: user?.uid ?? null,
    doc: null,
    epoch: 0,
    docTrusted: doc.trusted,
    emailLower,
  });

  const mode: FrameMode = useMemo(() => {
    if (editingOrigin && canEdit) {
      return { kind: "editing", baseVersion: editingOrigin.baseVersion, liveEpoch: editingOrigin.liveEpoch, draftRevision: editingOrigin.draftRevision };
    }
    const draft = readsDraft({
      hasDraft: Boolean(doc.meta?.draft),
      canEdit,
      shownVersion: doc.currentVersion,
      headVersion,
    });
    // A draft's script never runs, trusted or not: any editor may have written
    // it, and the server serves it locked anyway (ADR 0021).
    return { kind: "reading", versionId: doc.currentVersion, draft, sandboxed: draft || !trust.trusted };
  }, [editingOrigin, doc.currentVersion, doc.meta?.draft, canEdit, headVersion, trust.trusted]);
  /** A draft never runs its script, so trusting it would change nothing to offer. */
  const showsDraft = mode.kind === "reading" && mode.draft;

  const frame = useDocFrame({
    mode,
    docId,
    entry: editingOrigin?.entry ?? doc.entry,
    trustToken: trust.trustToken,
    linkToken: linkKey || undefined,
    // Editing is always sandboxed, so no answer could change how it loads.
    hold: mode.kind === "reading" && !trust.settled,
  });

  // Re-derived against the live document, so the trust prompt can ask "does it
  // actually contain scripts" rather than guessing.
  const liveTrust = useDocTrust({
    docId,
    uid: user?.uid ?? null,
    doc: frame.doc,
    epoch: frame.epoch,
    docTrusted: doc.trusted,
    emailLower,
  });

  // Who may propose an edit here, and on what (SPEC §22).
  const canSuggest = offersSuggest({
    signedIn,
    maySuggest: canSuggestDoc(doc.meta, emailLower, canEdit),
    mode,
    shownVersion: doc.currentVersion,
    headVersion,
    expired: frozen,
  });

  // The draft is on screen, and nothing inside the frame can say so: an
  // editor's reading view would otherwise be indistinguishable from the
  // published version its label names (SPEC §6a).
  const draftRecord = doc.meta?.draft;
  const draftOnScreen =
    mode.kind === "reading" && mode.draft && draftRecord
      ? (() => {
          const relative = formatRelative(draftRecord.updatedAt);
          return {
            byEmail: draftRecord.updatedByEmail,
            byYou: draftRecord.updatedByEmail?.toLowerCase() === emailLower,
            when:
              relative === "never" ? "" : /ago$|^just now$/.test(relative) ? relative : `on ${relative}`,
            version: doc.currentVersion,
          };
        })()
      : null;
  // How long the version on screen is, for the chip and Details alike.
  const shownWords = wordsOf(doc.currentVersion, { version: doc.version, latest: doc.meta?.latest, mirror: doc.publicDoc });

  // A form for a frame that has since reloaded, or gone into edit mode,
  // quotes a document that is no longer the one on screen.
  useEffect(() => setSuggesting(null), [mode.kind, frame.epoch]);

  // DECLARATION ORDER MATTERS. See the note at the top of this file.
  const annotationLayer = useAnnotationLayer({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    annotations,
    selectedId,
    onSelect: (id: string) => {
      setSelectedId(id);
      setCommentsOpen(true);
      setPane("comments");
    },
  });

  const presence = usePeerPresence({
    docId,
    uid: user?.uid ?? null,
    emailLower,
    displayName: user?.displayName || emailLower,
    doc: frame.doc,
    epoch: frame.epoch,
    mode: mode.kind === "editing" ? "edit" : "view",
    liveEpoch: mode.kind === "editing" ? mode.liveEpoch : currentLiveEpoch,
    enabled: signedIn && !throughFolder,
  });

  // Between the annotation layer and the editor, deliberately: cleanups run in
  // declaration order, so highlights are stripped before the shared document is
  // seeded from this DOM. Decoration reaching the CRDT does not contaminate one
  // save, it lands in every peer's copy.
  //
  // A member, or anyone on a PUBLIC open-editing document, shares the live log.
  // An unlisted document's link holder cannot — the realtime rules cannot see
  // a key — so they edit alone and publish through /draft (SPEC §16).
  // A public folder's reader is told "public" and still shares nothing live:
  // the realtime `*` key is the document's own level's alone.
  const shareLive =
    signedIn && !throughFolder && (Boolean(doc.meta) || doc.publicDoc?.visibility === "public");
  const remoteChanged = useRef<(() => void) | null>(null);
  // Where the frame delivers no `input` (viewer/frameWatch.ts), the shared
  // binding is what tells the editor this person typed: declared before the
  // editor, so it reaches it through a ref.
  const noteEdit = useRef<(() => void) | null>(null);
  const shared = useSharedDocument({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    docId,
    enabled: shareLive,
    liveEpoch: mode.kind === "editing" ? mode.liveEpoch : currentLiveEpoch,
    expectedCausal: editingOrigin?.causal,
    onRemote: () => remoteChanged.current?.(),
    onLocalChange: () => {
      if (refusesListeners(frame.doc)) noteEdit.current?.();
    },
  });

  const editor = useInlineEditor({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    docId,
    authoredAssets: frame.authoredAssets,
    ready: !shareLive || shared.bound,
    causalStamp: shared.causalStamp,
    flushShared: shared.flush,
    onStale: () => toast.error("Somebody published a newer version. Reload to continue."),
    sharedBound: shared.bound,
  });
  noteEdit.current = editor.markChanged;

  remoteChanged.current = editor.markChanged;

  // AFTER the editor, deliberately, and unlike every hook above it: this one
  // edits rather than decorates, in the session the editor owns, and marks its
  // target without a node or an attribute (see useSuggestionReview).
  const pendingSuggestions = useMemo(
    () => annotations.filter((a) => a.suggestion?.state === "pending"),
    [annotations],
  );
  // Whether the editing session is bound. An edit made before it is lost when
  // it binds, and a review mark made before it vanishes with the nodes binding
  // replaces; alone, there is nothing to wait for.
  const reviewReady = mode.kind === "editing" && (!shareLive || shared.bound);
  const reviewLayer = useSuggestionReview({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    active: review !== null,
    pending: pendingSuggestions,
    currentId: review?.currentId ?? null,
    ready: reviewReady,
    reduceMotion,
  });
  // What the comments panel calls stale while editing: the draft's verdict,
  // not the last one the reading view drew.
  const reviewStale = useMemo(() => [...reviewLayer.stale], [reviewLayer.stale]);

  const live = useLiveSync({
    meta: doc.meta,
    shownVersion: doc.currentVersion,
    emailLower,
    isEditing: mode.kind === "editing",
    liveEditorEmails: shared.state === "shared" ? presence.peers.filter((peer) => peer.mode === "edit").map((peer) => peer.email) : [],
    showsDraft: mode.kind === "reading" && mode.draft,
    hold: suggesting !== null || commenting,
    onPeerSavedDraft: frame.reload,
  });

  const deck = useDeck({
    doc: frame.doc,
    epoch: frame.epoch,
    // A dialog or the editor owns the keyboard while it is up: paging the deck
    // underneath the share dialog is somebody losing their place.
    keysEnabled: dialog === null && mode.kind === "reading",
  });

  // A deck that scales itself by script renders at full size in the
  // script-free editor, half of it out of reach; the frame is laid out at the
  // slides' width and scaled to the stage instead. Styles the iframe element
  // only, never the document, so it carries no ordering obligation.
  const stageRef = useRef<HTMLDivElement>(null);
  const frameFit = useFrameFit({
    doc: frame.doc,
    epoch: frame.epoch,
    active: mode.kind === "editing",
    slides: deck.slides,
    stageRef,
  });

  // An editor's browser captures the published head's thumbnails once, for
  // every member's workspace card and rail. Primitives only, because the
  // record behind them changes every minute somebody reads (SPEC §2, §6d).
  const isDeck = deck.slides.length > 1 && deck.paged;
  const thumb = doc.meta?.thumb;
  const thumbNeeds = captureNeeds({
    reading: mode.kind === "reading",
    draft: mode.kind === "reading" && mode.draft,
    shownVersion: doc.currentVersion,
    headVersion: doc.meta?.currentVersion ?? "",
    isDocEditor,
    isOwner,
    expired: frozen,
    sandboxed: mode.kind !== "reading" || mode.sandboxed,
    globallyTrusted: doc.meta?.trusted === true,
    thumbVersion: thumb?.versionId ?? null,
    thumbRevision: thumb?.rev ?? 1,
    hasCover: Boolean(thumb?.cover),
    hasSlides: Boolean(thumb?.slides),
    isDeck,
    slideCount: deck.slides.length,
  });
  useThumbCapture({
    docId,
    version: doc.meta?.currentVersion ?? "",
    frameDoc: frame.doc,
    epoch: frame.epoch,
    slides: deck.slides,
    isDeck,
    baseHref: contentBase(docId, doc.meta?.currentVersion ?? ""),
    needs: thumbNeeds,
  });

  useReadingSession({
    docId,
    versionId: doc.currentVersion || null,
    k: linkKey,
    doc: frame.doc,
    epoch: frame.epoch,
    enabled: mode.kind === "reading" && !mode.draft,
  });

  // Closes the gap the server-side shell title cannot: SPA navigation between
  // documents never re-requests `/d/**`, and a member of a private document
  // gets the generic shell regardless. Reads nothing from the frame and puts
  // nothing in the document the frame owns, so the decoration-ordering rule
  // above does not apply to it.
  useDocumentTitle(doc.title);

  // Subscribed again once the document is resolved as the reader signed in
  // now: on an unlisted document, the threads become readable only after
  // /unlock has recorded that account's grant.
  useEffect(() => {
    if (!doc.currentVersion || throughFolder) return;
    return listAnnotations(
      docId,
      doc.currentVersion,
      (anns) => {
        setAnnotationsUnreadable(false);
        setAnnotations(anns);
        settleComments(anns);
      },
      // Unreadable is not "none": the panel stays undecided, which reads as
      // closed, and the reader can still open it.
      () => {
        setAnnotationsUnreadable(true);
        setAnnotations([]);
      },
    );
  }, [docId, doc.currentVersion, settleComments, doc.resolvedFor, throughFolder]);

  useEffect(() => {
    if (!signedIn) return;
    const stopTeams = listMyTeams(emailLower, setTeams, () => setTeams([]));
    const stopFolders = listMyFolders(emailLower, setFolders, () => setFolders([]));
    return () => {
      stopTeams();
      stopFolders();
    };
  }, [signedIn, emailLower]);

  useEffect(() => {
    if (doc.format && frame.epoch > 0) {
      logEvent({
        name: "doc_open",
        params: { format: doc.format, sandboxed: !trust.trusted },
      });
    }
  }, [doc.format, frame.epoch > 0]);

  /** Turn the current selection into a thread. */
  const startComment = useCallback(async () => {
    if (!canWrite || !frame.doc) return;
    if (!user) {
      // The selection survives the prompt, and the comment posts afterwards.
      // Losing it here is where this feature dies.
      setPendingComment(true);
      setCommentsOpen(true);
      setPane("comments");
      return;
    }
    const anchor = describeAnchorFromSelection(frame.doc);
    if (!anchor) return;
    setCommenting(true);
    try {
      const annId = await createAnnotation(
        docId,
        doc.currentVersion,
        anchor,
        user.uid,
        emailLower,
      );
      logEvent({ name: "annotation_create", params: {} });
      setSelectedId(annId);
      setCommentsOpen(true);
      setPane("comments");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCommenting(false);
    }
  }, [canWrite, frame.doc, user, docId, doc.currentVersion, emailLower, toast]);

  /** Open the suggestion form on the current selection, trimmed to its text. */
  const startSuggest = useCallback(() => {
    if (!canSuggest) return;
    const d = frame.doc;
    const sel = d?.getSelection();
    if (!d || !sel || sel.rangeCount === 0) return;
    const range = trimToText(sel.getRangeAt(0));
    const anchor = describeAnchorFromRange(d, range);
    if (!anchor) return;
    const view = d.defaultView;
    setSuggesting({
      version: doc.currentVersion,
      anchor,
      position: popoverPosition(range.getBoundingClientRect(), {
        width: view?.innerWidth ?? 0,
        height: view?.innerHeight ?? 0,
      }),
    });
  }, [canSuggest, doc.currentVersion, frame.doc]);

  const submitSuggest = useCallback(
    async (replacement: string, note: string) => {
      if (!canSuggest || !suggesting || suggesting.version !== doc.currentVersion) return;
      try {
        const { annId } = await suggestEdit({
          docId,
          versionId: doc.currentVersion,
          anchor: suggesting.anchor,
          replacement,
          ...(note ? { note } : {}),
          ...(linkKey ? { k: linkKey } : {}),
        });
        setSuggesting(null);
        frame.doc?.getSelection()?.removeAllRanges();
        // Where it lands: its thread, open, so the author sees it took.
        setSelectedId(annId);
        setCommentsOpen(true);
        setPane("comments");
      } catch (e) {
        // The form stays open with what they wrote, so a retry costs nothing.
        toast.error((e as Error).message);
      }
    },
    [canSuggest, suggesting, docId, doc.currentVersion, linkKey, frame.doc, setCommentsOpen, toast],
  );

  /**
   * Finish a comment the reader started before signing in.
   *
   * The selection is still live in the document, because signing in never
   * unmounted the frame — so this is one call rather than "please highlight it
   * again", which is the version of this feature nobody uses twice.
   */
  useEffect(() => {
    if (!pendingComment || !signedIn || !user) return;
    // Not until the document is resolved as this account: on an unlisted
    // document that is what records the grant the comment is written under.
    if (doc.resolvedFor !== user.uid) return;
    setPendingComment(false);
    void startComment();
  }, [pendingComment, signedIn, user, doc.resolvedFor, startComment]);

  const commit = useCallback(async () => {
    if (!canEdit || mode.kind !== "editing" || mode.baseVersion !== doc.currentVersion) return;
    setCommitting(true);
    try {
      // Saved first, every time, and published only if that save went
      // through: never the previous draft's bytes reported as published.
      if (mode.kind !== "editing") return;
      const result = await publishSaved(editor.flushNow, () => commitVersion(docId, mode.baseVersion));
      if (!result) {
        toast.error("The draft didn’t save, so nothing was published. Try again.");
        return;
      }
      logEvent({ name: "version_commit", params: { format: doc.format } });
      // The server has retired the exact live session consumed by this commit.
      setWantsEdit(false);
      toast.show(
        result.deduped
          ? "No changes to publish — the content is identical."
          : `Published ${result.versionId}.`,
      );
      navigate(`/d/${docId}`);
    } catch (e) {
      if (e instanceof UnresolvedCommentsError) toast.error(e.message);
      else if (e instanceof StaleVersionError) toast.error(e.message);
      else toast.error((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [editor, mode, docId, doc.format, navigate, toast, setWantsEdit]);

  /** The export: a scrubbed, stamped snapshot of what the frame shows (SPEC §20). */
  const printCurrent = useCallback(() => {
    if (!frame.doc) return;
    void printDoc(frame.doc, {
      baseHref: contentBase(docId, doc.currentVersion, linkKey || undefined),
      marking: doc.marking,
      title: doc.title,
      version: doc.currentVersion,
      user: emailLower,
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open a print view."));
    logEvent({ name: "export", params: { kind: "pdf" } });
  }, [frame.doc, docId, doc.currentVersion, linkKey, doc.marking, doc.title, emailLower, toast]);

  // The owner stays on the page: it is theirs to read in the Trash, and the
  // banner that says so carries Restore, as the toast's Undo does (SPEC §4).
  const restoreFromTrash = useCallback(() => {
    void toast
      .during("Restoring…", restoreItem("doc", docId))
      .then(() => toast.show(`“${doc.title}” is back where it was, with its sharing.`))
      .catch((e) => toast.error((e as Error).message));
  }, [toast, docId, doc.title]);
  const moveToTrash = useCallback(() => {
    void toast
      .during("Moving to the Trash…", trashItem("doc", docId))
      .then(() => toast.show(`“${doc.title}” is in the Trash.`, { label: "Undo", onSelect: restoreFromTrash }))
      .catch((e) => toast.error((e as Error).message));
  }, [toast, docId, doc.title, restoreFromTrash]);

  // The browser's print, both ways it is reached. Cmd+P is the export above;
  // File → Print, which no event can redirect, prints this page with the
  // chrome hidden and the frame opened to its full height.
  usePrinting({
    doc: frame.doc,
    epoch: frame.epoch,
    enabled: dialog === null && mode.kind === "reading",
    onPrint: printCurrent,
  });

  // A file dropped onto the document opens the upload dialog with it, for
  // whoever may upload, while reading. Never while editing, where a drop
  // belongs to the editor, nor while presenting (SPEC §2).
  const openUpload = useCallback((file: File | null) => {
    if (!offersUpload) return;
    setDroppedFile(file);
    setDialog("upload-version");
  }, [offersUpload]);
  const versionDrop = useVersionDrop({
    enabled: offersUpload && mode.kind === "reading" && !presenting && dialog === null,
    doc: frame.doc,
    epoch: frame.epoch,
    onFile: openUpload,
  });

  const editorMounted = useRef(true);
  useEffect(() => {
    editorMounted.current = true;
    return () => { editorMounted.current = false; };
  }, []);
  const activeEditor = useRef({ origin: editingOrigin, doc: frame.doc });
  activeEditor.current = { origin: editingOrigin, doc: frame.doc };
  /**
   * Leave the editor without publishing.
   *
   * The pending autosave is flushed FIRST. `useInlineEditor`'s cleanup clears
   * the debounce timer, so leaving within a second of the last keystroke would
   * otherwise drop that keystroke on the floor — silently, since the draft that
   * remains looks perfectly healthy.
   */
  const stopEditing = useCallback(async () => {
    const started = activeEditor.current;
    const saved = await editor.flushUnsaved();
    if (!editorMounted.current || activeEditor.current.origin !== started.origin || activeEditor.current.doc !== started.doc) return;
    if (!saved) {
      toast.error("Your changes are not fully saved and shared. Keep this editor open and try again.");
      return;
    }
    setWantsEdit(false);
  }, [editor, toast, setWantsEdit]);

  const interactionVersion = useRef(doc.currentVersion);
  useEffect(() => {
    if (!canWrite || interactionVersion.current !== doc.currentVersion) {
      if (!canWrite) setWantsEdit(false);
      setSuggesting(null);
      setPendingComment(false);
      setReview(null);
      setDialog((value) => value === "upload-version" ? null : value);
    }
    interactionVersion.current = doc.currentVersion;
  }, [canWrite, doc.currentVersion, setWantsEdit]);

  // Leaving the editor ends the review pass; it lives in the editing session.
  useEffect(() => {
    if (!wantsEdit) setReview(null);
  }, [wantsEdit]);

  /** Whether this browser accepted anything in the pass now open: the only case with a result to publish. */
  const acceptedInPass = useRef(false);

  /** Open the review pass in the editor, on one suggestion or the first. */
  const startReview = useCallback(
    (annId?: string) => {
      if (!canEdit) return;
      acceptedInPass.current = false;
      setReview({ currentId: annId ?? pendingSuggestions[0]?.annId ?? null });
      setWantsEdit(true);
    },
    [pendingSuggestions, setWantsEdit],
  );

  // Somebody decided the one on screen — this browser, another approver, or
  // its author by withdrawing it — so move on to the one after it; and close
  // the pass once nothing is left to decide, saying only what is true.
  const lastPending = useRef(pendingSuggestions.map((a) => a.annId));
  useEffect(() => {
    const before = lastPending.current;
    const now = pendingSuggestions.map((a) => a.annId);
    lastPending.current = now;
    if (!review) return;
    if (now.length === 0) {
      setReview(null);
      if (before.length > 0) {
        toast.show(
          passEndNotice({
            acceptedHere: acceptedInPass.current,
            openComments: annotations.some((a) => !a.resolved),
            unreadable: annotationsUnreadable,
          }),
        );
      }
      return;
    }
    const next = followingSuggestion(before, now, review.currentId);
    if (next !== review.currentId) setReview({ currentId: next });
  }, [review, pendingSuggestions, annotations, annotationsUnreadable, toast]);

  const suggestionWhere = useCallback(
    (annId: string) => ({ docId, versionId: doc.currentVersion, annId, ...(linkKey ? { k: linkKey } : {}) }),
    [docId, doc.currentVersion, linkKey],
  );

  const acceptCurrent = useCallback(
    async (a: Annotation) => {
      if (!canEdit || deciding || !a.suggestion) return;
      setDeciding(true);
      try {
        const outcome = await acceptInSession({
          check: () => (frame.doc ? resolveSuggestion(frame.doc, a.anchor, a.suggestion!.replacement).state : "stale"),
          claim: () => claimSuggestion({ ...suggestionWhere(a.annId), replacement: a.suggestion!.replacement }),
          release: () => releaseSuggestion(suggestionWhere(a.annId)),
          apply: () => (frame.doc ? applySuggestion(frame.doc, a.anchor, a.suggestion!.replacement) : "failed"),
          flush: () => editor.flushNow(),
          saveFailed: () => editor.saveFailed(),
          record: () => {
            // Set before the request, not after it: the snapshot that drops it
            // from pending can arrive before the response, and end the pass
            // first. By now the change is in the saved draft either way.
            acceptedInPass.current = true;
            return acceptSuggestion({ ...suggestionWhere(a.annId), replacement: a.suggestion!.replacement });
          },
        });
        if (outcome === "stale") {
          toast.error("The text has changed since this was suggested, so it can’t be applied.");
        } else if (outcome === "failed") {
          toast.error("The change couldn’t be made in the document, so nothing was accepted. Try again, or make it by hand.");
        } else if (outcome === "unverified") {
          toast.error("The passage changed, but not as suggested, and it couldn’t be undone. Check it before you publish. Nothing was accepted.");
        } else if (outcome === "changed-after-apply") {
          toast.error("The suggestion changed after its previous text was saved in the draft. Nothing was accepted. Review that change and undo it if needed before deciding the revised suggestion.");
        } else if (outcome === "unrecorded") {
          toast.error("The change is in the draft, but accepting it wasn’t recorded. Accept it again to record it.");
        } else if (outcome === "unsaved") {
          toast.error("The change is made, but the draft didn’t save, so it isn’t accepted yet. Accept it again once it saves.");
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setDeciding(false);
      }
    },
    [canEdit, deciding, suggestionWhere, frame.doc, editor, toast],
  );

  const rejectCurrent = useCallback(
    async (a: Annotation, reason: string): Promise<boolean> => {
      if (!canWrite || deciding) return false;
      setDeciding(true);
      try {
        await rejectSuggestion({ ...suggestionWhere(a.annId), ...(reason ? { reason } : {}) });
        return true;
      } catch (e) {
        toast.error((e as Error).message);
        return false;
      } finally {
        setDeciding(false);
      }
    },
    [canWrite, deciding, suggestionWhere, toast],
  );

  const menuEntries: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = [
      { id: "h-export", label: "Download", heading: true },
      {
        id: "html",
        label: doc.format === "markdown" ? "Download the rendered HTML" : "Download the HTML",
        onSelect: () => {
          void toast
            .during(
              "Downloading…",
              downloadEntry(docId, doc.currentVersion, doc.entry, doc.title, {
                linkKey: linkKey || undefined,
              }),
            )
            .catch((e) => toast.error((e as Error).message));
          logEvent({ name: "export", params: { kind: "html" } });
        },
      },
    ];
    if (doc.sourceEntry) {
      entries.push({
        id: "source",
        label: "Download the Markdown source",
        onSelect: () => {
          void toast
            .during(
              "Downloading…",
              downloadSource(
                docId,
                doc.currentVersion,
                doc.sourceEntry!,
                doc.title,
                linkKey || undefined,
              ),
            )
            .catch((e) => toast.error((e as Error).message));
          logEvent({ name: "export", params: { kind: "html" } });
        },
      });
    }
    if (doc.fileCount > 1) {
      entries.push({
        id: "zip",
        label: "Download everything as a .zip",
        onSelect: () => {
          downloadZip(docId, doc.currentVersion, linkKey || undefined);
          logEvent({ name: "export", params: { kind: "zip" } });
        },
      });
    }
    // On a phone Print is listed here instead of on the toolbar: the bar
    // already fills 400px, and printing from a phone is rare enough to sit one
    // tap further away. Anywhere wider it is a button and is not listed twice.
    if (phone) entries.push({ id: "pdf", label: "Print or save as PDF", onSelect: printCurrent });
    entries.push(
      { id: "image", label: "Export an image…", onSelect: () => setDialog("image") },
      { id: "sep1", separator: true },
    );

    entries.push({ id: "h-doc", label: "This document", heading: true });
    // For every reader: how long it is and when it was updated is anyone's to
    // know; who did it and every version is a member's (DetailsPanel).
    entries.push({ id: "details", label: "Details…", onSelect: () => setDialog("details") });
    // For every reader, owner and anonymous alike — a reader who is not signed
    // in is sent to sign in and comes back to the fork (SPEC §21).
    entries.push({
      id: "fork",
      label: forkVersion ? "Fork this version" : "Fork",
      disabled: forking,
      onSelect: fork,
    });
    if (doc.meta) {
      entries.push({ id: "stats", label: "Activity", onSelect: () => setDialog("stats") });
      if (offersUpload) {
        // Not reachable while editing: the editor's toolbar replaces this menu.
        entries.push({ id: "upload-version", label: "Upload a new version…", onSelect: () => openUpload(null) });
      }
      if (isOwner && !trashed) {
        entries.push(
          // One entry for who has access AND who can see it: they were two,
          // and the second was found only by reading this menu.
          { id: "share", label: "Share…", onSelect: () => setDialog("share") },
          { id: "marking", label: "Marking on exports…", onSelect: () => setDialog("marking") },
        );
      }
      if (isOwner) {
        entries.push(
          { id: "forks", label: "Forks…", onSelect: () => setDialog("forks") },
          trashed
            ? { id: "restore", label: "Restore from Trash", onSelect: restoreFromTrash }
            : { id: "trash", label: "Move to Trash", danger: true, onSelect: moveToTrash },
        );
      }
    }

    if (doc.versions.length > 1) {
      entries.push({ id: "sep2", separator: true });
      entries.push({ id: "h-versions", label: "Versions", heading: true });
      for (const v of [...doc.versions].reverse().slice(0, 8)) {
        entries.push({
          id: v.versionId,
          label:
            v.versionId === doc.meta?.currentVersion
              ? `${v.versionId} — current`
              : v.versionId,
          disabled: v.versionId === doc.currentVersion,
          onSelect: () => navigate(`/d/${docId}/${v.versionId}${linkKey ? `?k=${encodeURIComponent(linkKey)}` : ""}`),
        });
      }
    }
    return entries;
  }, [doc, docId, linkKey, isOwner, navigate, toast, fork, forking, forkVersion, offersUpload, openUpload, phone, printCurrent, trashed, moveToTrash, restoreFromTrash]);

  // Nothing is asked for until the gate settles, so on a full page load the
  // first wait is the sign-in round trip, and it is named as such. Try again
  // reloads the page: a stalled sign-in or Listen does not recover in place.
  if (doc.loading) {
    return (
      <Loading
        label={gate === "loading" ? signingInLabel(movingTo) : "Opening the document"}
        onRetry={() => window.location.reload()}
      />
    );
  }
  if (doc.notFound) return <NotHere />;

  const editingNow = mode.kind === "editing";
  const showComments = commentsOpen && Boolean(doc.currentVersion) && !throughFolder;
  /**
   * The navigator is for DECKS, not for anything with two sections in it.
   *
   * `paged` is true only when slides measure about one viewport tall, which is
   * the same signal the arrow keys already use. Without it a long article gets
   * a rail of illegible thumbnails of prose — sections whose heights differ
   * tenfold, scaled to a smudge — and the reader pays a function invocation per
   * preview for the privilege. It is latched in `useDeck`, so opening the rail
   * cannot narrow the frame into changing the answer.
   */
  const hasSlides = deck.slides.length > 1 && deck.paged;
  // The published deck's stored rail, when this is exactly what was captured:
  // one request per slide, kept by the browser, instead of a live preview that
  // fetches each slide's assets again on every visit. Null while editing or on
  // a draft, whose slides are not the stored ones.
  const railImages = storedSlideImages(docId, doc.meta?.thumb, {
    reading: mode.kind === "reading",
    draft: mode.kind === "reading" && mode.draft,
    shownVersion: doc.currentVersion,
    slideCount: deck.slides.length,
  });
  // The same base the print export uses. Without it a preview's relative
  // images resolve against the app origin and every one of them 404s.
  const baseHref = contentBase(docId, doc.currentVersion, linkKey || undefined);
  // Structural slide edits are DOM surgery: they fire no input event, so
  // autosave has to be told, and the slide list has to be read again.
  const onSlidesChanged = () => {
    frame.doc?.dispatchEvent(new Event("input", { bubbles: true }));
    deck.rescan();
  };

  return (
    <div className="viewer" data-pane={pane}>
      {editingNow ? (
        <EditToolbar
          format={doc.formatReady ? doc.format : null}
          doc={frame.doc}
          saveState={editor.saveState}
          saveError={editor.saveError}
          sharing={shared.state}
          onCommit={() => void commit()}
          onExit={() => void stopEditing()}
          committing={committing}
          commitDisabled={!reviewReady || annotations.some((a) => !a.resolved)}
          commitDisabledReason={!reviewReady ? "Wait for the shared document to join." : publishBlockedReason({
            pending: pendingSuggestions.length,
            unresolved: annotations.some((a) => !a.resolved),
            canDecide: isApprover(doc.meta, emailLower),
          })}
        />
      ) : null}
      {editingNow ? (
        <ReviewBar
          pending={pendingSuggestions}
          canDecide={isApprover(doc.meta, emailLower)}
          reviewing={review !== null}
          currentId={review?.currentId ?? null}
          stale={reviewLayer.stale}
          ready={reviewReady}
          busy={deciding}
          onStart={() => startReview()}
          onGo={(annId) => setReview({ currentId: annId })}
          onAccept={(a) => void acceptCurrent(a)}
          onReject={rejectCurrent}
          onDone={() => setReview(null)}
        />
      ) : (
        <ViewerToolbar
          title={doc.title}
          folderId={doc.meta?.folderId ?? null}
          folders={folders}
          versionLabel={draftOnScreen ? `${doc.currentVersion} · draft` : `${doc.currentVersion}${shownWords === undefined ? "" : ` · ${readingMinutes(shownWords)} min`}`}
          onDetails={() => setDialog("details")}
          // The member record, or the projection: a reader of a public document
          // who is not a member is told too, which is what the projection
          // carries the date for (SPEC §17).
          expiresAt={doc.meta?.expiresAt ?? doc.publicDoc?.expiresAt ?? null}
          expiryOf={throughFolder ? "folder-link" : "document"}
          onExpiry={isOwner ? () => setDialog("share") : undefined}
          peers={presence.peers}
          following={presence.following}
          onToggleFollow={presence.toggleFollow}
          commentsOpen={commentsOpen}
          onToggleComments={throughFolder ? undefined : () => setCommentsOpen((v) => !v)}
          canEdit={canEdit}
          canShare={isOwner && !trashed}
          onShare={() => setDialog("share")}
          onFork={fork}
          forking={forking}
          forked={forked}
          // The count is the owner's to be shown here; a member still sees it
          // on the workspace card, as they see the view count (SPEC §21).
          forkCount={isOwner ? (doc.meta?.stats?.forks ?? 0) : 0}
          lineage={lineage.lineage}
          onOpenForks={() => setDialog("forks")}
          editing={wantsEdit}
          onToggleEdit={() => void (wantsEdit ? stopEditing() : canEdit && setWantsEdit(true))}
          offerTrust={liveTrust.shouldOffer && !showsDraft}
          onOpenTrust={() => setDialog("trust")}
          hasSlides={hasSlides}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((open) => !open)}
          onOverview={() => deck.setOverviewOpen(true)}
          onPresent={startPresenting}
          onPrint={phone ? undefined : printCurrent}
          menuEntries={menuEntries}
          pane={pane}
          onPane={(next) => {
            setPane(next);
            // The panel shows only while it is open; with no open threads it
            // starts closed, and choosing the tab showed an empty screen.
            if (next === "comments") setCommentsOpen(true);
          }}
          singleColumn={singleColumn}
        />
      )}

      {editOpenError || frame.loadError || editor.reloadRequired ? (
        <div className="banner banner-warn" role="alert">
          {editOpenError ?? frame.loadError ?? editor.saveError}{" "}
          <button className="btn btn-sm" onClick={() => void reloadEditing()}>Reload draft</button>
        </div>
      ) : null}
      {mode.kind === "editing" && shared.error ? (
        <div className="banner banner-warn" role="alert">
          {shared.error}{" "}
          {!shared.bound ? <button className="btn btn-sm" onClick={() => void setWantsEdit(false)}>Leave editing</button> : null}
        </div>
      ) : null}
      <ViewerBanners
        trashed={trashed && isOwner ? { onRestore: restoreFromTrash } : null}
        draft={draftOnScreen}
        historical={!isCurrent && Boolean(doc.currentVersion)}
        onEdit={() => canEdit && setWantsEdit(true)}
        newVersion={live.newVersion}
        onOpenNewVersion={() => navigate(`/d/${docId}${linkKey ? `?k=${encodeURIComponent(linkKey)}` : ""}`)}
        onDismissNewVersion={live.dismissNewVersion}
        conflict={live.conflict}
        onTakeTheirs={() => {
          live.dismissConflict();
          void reloadEditing();
        }}
        onKeepMine={live.dismissConflict}
        orphanedCount={annotationLayer.orphaned.length}
        offerTrust={liveTrust.shouldOffer && !showsDraft}
        scriptsBuildContent={deck.scan.kind === "script-required"}
        onOpenTrust={() => setDialog("trust")}
      />

      {/* One source of truth for "is the panel there", because the layout and
          the panel must agree — a version-less document renders no panel
          whatever the toggle says. */}
      <div className="viewer-body" data-comments={showComments ? "open" : "closed"}>
        <div
          className="doc-frame-wrap"
          // One ratio for every thumbnail in the deck, published at the common
          // ancestor of the rail and the overview so they cannot disagree.
          style={{ ["--thumb-ratio" as string]: `${deck.stage.width} / ${deck.stage.height}` }}
        >
          {/* Presenting hides the rail; the overview stays reachable, so there
              is still a way to jump without leaving the presentation. */}
          {hasSlides && railOpen && !presenting ? (
            <SlidePanel
              slides={deck.slides}
              current={deck.current}
              editable={editingNow && reviewReady}
              drawerOpen={singleColumn ? railOpen : undefined}
              baseHref={baseHref}
              stage={deck.stage}
              images={railImages}
              onGoTo={deck.goTo}
              onChanged={onSlidesChanged}
            />
          ) : null}
          {/*
            The frame gets its own positioned box, and SelectionFab lives INSIDE
            it. The FAB is placed from a rect read through the frame's viewport
            but rendered against its offset parent, so leaving it a child of the
            wrapper would put every button a rail's width too far left the moment
            the rail took a column.
          */}
          <div
            className="doc-frame-stage"
            ref={stageRef}
            style={frameFit ? { overflow: "hidden" } : undefined}
            {...versionDrop.handlers}
          >
            {frame.frameProps ? (
              <iframe
                {...frame.frameProps}
                ref={frame.ref}
                className="doc-frame"
                title={doc.title}
                style={frameFit}
              />
            ) : null}
            {/* Over the frame, never in it: this is the parent's DOM, so it
                cannot reach the document's serialized bytes. It covers every
                load the frame makes — first open, edit mode, a trust grant, a
                reload — which is a blank white box without it. */}
            {frame.loading ? (
              <div className="frame-loading">
                <Loading label="Loading the page" onRetry={frame.reload} />
              </div>
            ) : null}
            {/* Over the frame, like the loading cover, and for the same
                reason: a drag over the frame is the frame's, so this is what
                takes the drop once a file has been dragged in. */}
            {versionDrop.over ? (
              <div className="frame-drop">
                <Icon name="upload" size={28} />
                <strong>Drop to publish it as a new version</strong>
                <span className="caption">You can check it before it is published.</span>
              </div>
            ) : null}
            <SelectionFab
              doc={frame.doc}
              epoch={frame.epoch}
              enabled={canWrite && mode.kind === "reading" && !commenting && !suggesting}
              label={user ? "Comment" : "Sign in to comment"}
              onComment={() => void startComment()}
              suggest={
                canSuggest
                  ? { onSuggest: startSuggest, onRefused: (reason) => toast.show(reason) }
                  : undefined
              }
            />
            {suggesting ? (
              <SuggestPopover
                position={suggesting.position}
                docked={coarsePointer}
                exact={suggesting.anchor.exact}
                initial={suggesting.anchor.exact}
                submitLabel="Suggest"
                onSubmit={submitSuggest}
                onCancel={() => setSuggesting(null)}
              />
            ) : null}
          </div>
          {presenting && hasSlides ? (
            <span className="present-counter">
              {deck.current + 1} / {deck.slides.length}
            </span>
          ) : null}
          {deck.overviewOpen && hasSlides ? (
            <SlideOverview
              slides={deck.slides}
              current={deck.current}
              baseHref={baseHref}
              stage={deck.stage}
              images={railImages}
              onGoTo={deck.goTo}
              onClose={() => deck.setOverviewOpen(false)}
            />
          ) : null}
          {presenting ? (
            <button
              type="button"
              className="btn present-exit"
              onClick={stopPresenting}
            >
              Exit
            </button>
          ) : null}
        </div>

        {showComments ? (
          <Sidebar
            key={`${docId}/${doc.currentVersion}`}
            readOnly={!canWrite}
            docId={docId}
            versionId={doc.currentVersion}
            annotations={annotations}
            orphaned={annotationLayer.orphaned}
            stale={mode.kind === "editing" ? reviewStale : annotationLayer.stale}
            isApprover={isApprover(doc.meta, emailLower)}
            linkKey={linkKey || undefined}
            onReview={canEdit ? startReview : undefined}
            selectedId={selectedId}
            canComment={canWrite && signedIn}
            signedIn={signedIn}
            peers={presence.peers}
            uid={user?.uid ?? null}
            emailLower={emailLower}
            onSelect={setSelectedId}
            onComposing={presence.setComposing}
            onSignIn={() => navigate("/signup")}
            onClose={() => setCommentsOpen(false)}
          />
        ) : null}
      </div>

      {dialog === "share" && doc.meta ? (
        <SharePanel
          target={{
            kind: "doc",
            id: docId,
            title: doc.title,
            ownerEmail: doc.meta.ownerEmail,
            viewers: doc.meta.viewers,
            editors: doc.meta.editors,
            suggesters: doc.meta.suggesters,
            approvers: doc.meta.approvers,
            members: doc.meta.members,
          }}
          teams={teams}
          isOwner={isOwner}
          visibility={visibilityStateOf(doc.meta)}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "trust" ? (
        <TrustDialog
          docId={docId}
          isOwner={isOwner}
          personallyTrusted={liveTrust.personallyTrusted}
          onClose={() => setDialog(null)}
          onPersonalTrust={liveTrust.grantPersonal}
        />
      ) : null}

      {dialog === "marking" && doc.meta ? (
        <MarkingDialog
          docId={docId}
          current={doc.meta.marking ?? MARKING_OFF}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "details" ? (
        <DetailsPanel
          title={doc.title}
          docId={docId}
          linkKey={linkKey || undefined}
          meta={doc.meta}
          publicDoc={doc.publicDoc}
          versions={doc.versions}
          viewing={doc.currentVersion}
          words={shownWords}
          slides={deck.slides.length}
          showDraft={isDocEditor}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "stats" && doc.meta ? (
        <StatsPanel
          meta={doc.meta}
          canSeeDetail={isDocEditor}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "forks" ? (
        <ForksPanel
          title={doc.title}
          forked={forked}
          isOwner={isOwner}
          signedIn={signedIn}
          lineage={lineage.lineage}
          failed={lineage.failed}
          onRefresh={lineage.refresh}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "upload-version" && doc.meta ? (
        <UploadVersionDialog
          docId={docId}
          title={doc.title}
          headVersion={headVersion}
          trusted={trust.trusted}
          draftBy={doc.meta.draft?.updatedByEmail ?? null}
          editing={presence.peers.filter((p) => p.mode === "edit").map((p) => p.name || p.email)}
          initialFile={droppedFile}
          onClose={() => setDialog(null)}
          onPublished={(result) => {
            setDialog(null);
            toast.show(versionUploadMessage(result));
            navigate(`/d/${docId}`);
          }}
        />
      ) : null}

      {dialog === "image" ? (
        <ImageExportDialog
          doc={frame.doc}
          title={doc.title}
          version={doc.currentVersion}
          user={emailLower}
          marking={doc.marking}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
