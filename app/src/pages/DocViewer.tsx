// SPDX-License-Identifier: Apache-2.0
// The document viewer: composition only (SPEC §6, §6a, §6c, §16, §17).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth";
import { logEvent } from "../analytics";
import { createAnnotation, listAnnotations, listMyFolders, listMyTeams } from "../firestore";
import { describeAnchorFromSelection } from "../annotation/anchor";
import { Sidebar } from "../annotation/Sidebar";
import { commitVersion, UnresolvedCommentsError, StaleVersionError } from "../edit";
import { downloadEntry, downloadSource, downloadZip } from "../export/html";
import { printDoc } from "../export/pdf";
import { MARKING_OFF } from "../export/labels";
import { useIsSingleColumn } from "../hooks/useMediaQuery";

import { useDocument } from "../viewer/useDocument";
import { useDocFrame } from "../viewer/useDocFrame";
import { useAnnotationLayer } from "../viewer/useAnnotationLayer";
import { useInlineEditor } from "../viewer/useInlineEditor";
import { useSharedDocument } from "../viewer/useSharedDocument";
import { clearLog } from "../crdt/rtdb";
import { useDocTrust } from "../viewer/useDocTrust";
import { useReadingSession } from "../viewer/useReadingSession";
import { usePeerPresence } from "../viewer/usePeerPresence";
import { useLiveSync } from "../viewer/useLiveSync";
import type { FrameMode } from "../viewer/frameMode";

import { EditToolbar } from "../wysiwyg/EditToolbar";
import { ViewerToolbar } from "../components/ViewerToolbar";
import { ViewerBanners } from "../components/ViewerBanners";
import { SelectionFab } from "../components/SelectionFab";
import { SlidePanel } from "../components/SlidePanel";
import { SharePanel } from "../components/SharePanel";
import { VisibilityDialog } from "../components/VisibilityDialog";
import { TrustDialog } from "../components/TrustDialog";
import { MarkingDialog } from "../components/MarkingDialog";
import { StatsPanel } from "../components/StatsPanel";
import { ImageExportDialog } from "../components/ImageExportDialog";
import { Loading } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { expiryLabel, expiryMs, isExpired } from "../expiry";
import type { MenuEntry } from "../components/Menu";
import type { Annotation, FolderMeta, TeamMeta } from "../types";

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
 */

type Dialog =
  | null
  | "share"
  | "visibility"
  | "trust"
  | "marking"
  | "stats"
  | "image";

export function DocViewer() {
  const { docId = "", versionId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, emailLower, gate } = useAuth();
  const singleColumn = useIsSingleColumn();

  const doc = useDocument(docId, versionId);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [teams, setTeams] = useState<TeamMeta[]>([]);
  // Only for the breadcrumb. An anonymous reader of a public document has no
  // folders and gets a trail of one, which is correct: "Everything" is still
  // where the workspace is if they sign in.
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [wantsEdit, setWantsEdit] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [pane, setPane] = useState<"doc" | "comments">("doc");
  const [presenting, setPresenting] = useState(false);

  /**
   * Presentation is an APP-level state, so its class goes on <body>.
   *
   * It used to go on this component's own .viewer div, which quietly broke two
   * of the four things it claims to do: `.is-presenting .app-header` never
   * matched, because the header is a sibling of <main> and not a descendant of
   * the viewer, and `.is-presenting .viewer` never matched either, because
   * .viewer CARRIED the class rather than descending from it. Presenting
   * therefore left the application header on screen over the document.
   *
   * On <body> every one of those selectors means what it reads as — including
   * hiding the cookie banner, which would otherwise be the only chrome left on
   * somebody's full-window presentation.
   */
  useEffect(() => {
    document.body.classList.toggle("is-presenting", presenting);
    return () => document.body.classList.remove("is-presenting");
  }, [presenting]);
  const [pendingComment, setPendingComment] = useState(false);

  const signedIn = gate === "ready" && Boolean(user);
  const isOwner = doc.meta?.ownerEmail === emailLower;
  const isDocEditor = Boolean(
    doc.meta &&
      (isOwner ||
        doc.meta.editors?.includes(emailLower) ||
        doc.meta.editorMembers?.includes(emailLower)),
  );
  // Open editing widens WHO, never to anyone: a signed-in account is still
  // required, on every document, whatever its owner chose.
  const canEdit = isDocEditor || (signedIn && doc.publicEdit);

  const trust = useDocTrust({
    docId,
    uid: user?.uid ?? null,
    doc: null,
    epoch: 0,
    docTrusted: doc.trusted,
    emailLower,
  });

  const mode: FrameMode = useMemo(
    () =>
      wantsEdit
        ? { kind: "editing", baseVersion: doc.currentVersion }
        : {
            kind: "reading",
            versionId: doc.currentVersion,
            draft: Boolean(doc.meta?.draft) && canEdit,
            sandboxed: !trust.trusted,
          },
    [wantsEdit, doc.currentVersion, doc.meta?.draft, canEdit, trust.trusted],
  );

  const frame = useDocFrame({
    mode,
    docId,
    entry: doc.entry,
    trustToken: trust.trustToken,
    linkToken: params.get("k") ?? undefined,
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

  // DECLARATION ORDER MATTERS. See the note at the top of this file.
  const annotationLayer = useAnnotationLayer({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    annotations,
    selectedId,
    onSelect: setSelectedId,
  });

  const presence = usePeerPresence({
    docId,
    uid: user?.uid ?? null,
    emailLower,
    displayName: user?.displayName || emailLower,
    doc: frame.doc,
    epoch: frame.epoch,
    mode: mode.kind === "editing" ? "edit" : "view",
    enabled: signedIn,
  });

  // Between the annotation layer and the editor, deliberately: cleanups run in
  // declaration order, so highlights are stripped before the shared document is
  // seeded from this DOM. Decoration reaching the CRDT does not contaminate one
  // save, it lands in every peer's copy.
  const shared = useSharedDocument({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    docId,
    enabled: signedIn,
  });

  const editor = useInlineEditor({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    docId,
    authoredAssets: frame.authoredAssets,
    onStale: () => toast.error("Somebody published a newer version. Reload to continue."),
  });

  const live = useLiveSync({
    meta: doc.meta,
    emailLower,
    isEditing: mode.kind === "editing",
    onPeerSavedDraft: frame.reload,
  });

  useReadingSession({
    docId,
    versionId: doc.currentVersion || null,
    doc: frame.doc,
    epoch: frame.epoch,
    enabled: mode.kind === "reading" && !mode.draft,
  });

  useEffect(() => {
    if (!doc.currentVersion) return;
    return listAnnotations(docId, doc.currentVersion, setAnnotations, () => setAnnotations([]));
  }, [docId, doc.currentVersion]);

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
    if (!frame.doc) return;
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
    }
  }, [frame.doc, user, docId, doc.currentVersion, emailLower, toast]);

  /**
   * Finish a comment the reader started before signing in.
   *
   * The selection is still live in the document, because signing in never
   * unmounted the frame — so this is one call rather than "please highlight it
   * again", which is the version of this feature nobody uses twice.
   */
  useEffect(() => {
    if (!pendingComment || !signedIn) return;
    setPendingComment(false);
    void startComment();
  }, [pendingComment, signedIn, startComment]);

  const commit = useCallback(async () => {
    if (editor.saveFailed()) {
      // Publishing now would promote the PREVIOUS draft bytes while reporting
      // success, which is the worst available outcome.
      toast.error("The last save did not go through. Fix that before publishing.");
      return;
    }
    await editor.flushNow();
    try {
      const result = await commitVersion(docId, doc.currentVersion);
      logEvent({ name: "version_commit", params: { format: doc.format } });
      // The shared document described the DRAFT, which the commit has just
      // consumed. Leaving it behind means the next person to open the editor
      // syncs the old draft from the log and it reappears on top of the version
      // that replaced it — published work silently reverted by a stale cache.
      await clearLog(docId);
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
    }
  }, [editor, docId, doc.currentVersion, doc.format, navigate, toast]);

  /**
   * Leave the editor without publishing.
   *
   * The pending autosave is flushed FIRST. `useInlineEditor`'s cleanup clears
   * the debounce timer, so leaving within a second of the last keystroke would
   * otherwise drop that keystroke on the floor — silently, since the draft that
   * remains looks perfectly healthy.
   */
  const stopEditing = useCallback(async () => {
    await editor.flushNow();
    setWantsEdit(false);
  }, [editor]);

  const menuEntries: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = [
      { id: "h-export", label: "Download", heading: true },
      {
        id: "html",
        label: doc.format === "markdown" ? "Download the rendered HTML" : "Download the HTML",
        onSelect: () => {
          void downloadEntry(docId, doc.currentVersion, doc.entry, doc.title);
          logEvent({ name: "export", params: { kind: "html" } });
        },
      },
    ];
    if (doc.version?.sourceEntry) {
      entries.push({
        id: "source",
        label: "Download the Markdown source",
        onSelect: () => {
          void downloadSource(docId, doc.currentVersion, doc.version!.sourceEntry!, doc.title);
          logEvent({ name: "export", params: { kind: "html" } });
        },
      });
    }
    if ((doc.version?.fileCount ?? 1) > 1) {
      entries.push({
        id: "zip",
        label: "Download everything as a .zip",
        onSelect: () => {
          downloadZip(docId, doc.currentVersion);
          logEvent({ name: "export", params: { kind: "zip" } });
        },
      });
    }
    entries.push(
      {
        id: "pdf",
        label: "Print or save as PDF",
        onSelect: () => {
          if (!frame.doc) return;
          void printDoc(frame.doc, {
            baseHref: `/content/${docId}/${doc.currentVersion}/`,
            marking: doc.meta?.marking ?? MARKING_OFF,
            title: doc.title,
            version: doc.currentVersion,
            user: emailLower,
          });
          logEvent({ name: "export", params: { kind: "pdf" } });
        },
      },
      { id: "image", label: "Export an image…", onSelect: () => setDialog("image") },
      { id: "sep1", separator: true },
    );

    if (doc.meta) {
      entries.push({ id: "h-doc", label: "This document", heading: true });
      entries.push({ id: "stats", label: "Activity", onSelect: () => setDialog("stats") });
      if (isOwner) {
        entries.push(
          { id: "share", label: "Share…", onSelect: () => setDialog("share") },
          { id: "visibility", label: "Who can see it…", onSelect: () => setDialog("visibility") },
          { id: "marking", label: "Marking on exports…", onSelect: () => setDialog("marking") },
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
          onSelect: () => navigate(`/d/${docId}/${v.versionId}`),
        });
      }
    }
    return entries;
  }, [doc, docId, frame.doc, isOwner, emailLower, navigate]);

  if (doc.loading) return <Loading label="Opening the document" />;
  if (doc.notFound) {
    return (
      <div className="empty-state">
        <h1>Not here</h1>
        <p>
          {/* Deliberately indistinguishable from "you may not read this": with
              no domain gate, a difference between the two would let anyone walk
              the slug space. */}
          This document does not exist, or you do not have access to it.
        </p>
      </div>
    );
  }

  const editingNow = mode.kind === "editing";
  const showComments = commentsOpen && Boolean(doc.currentVersion);

  return (
    <div className="viewer" data-pane={pane}>
      {editingNow ? (
        <EditToolbar
          format={doc.format}
          doc={frame.doc}
          saveState={editor.saveState}
          saveError={editor.saveError}
          sharing={shared.state}
          onCommit={() => void commit()}
          onExit={() => void stopEditing()}
          commitDisabled={annotations.some((a) => !a.resolved)}
          commitDisabledReason={
            annotations.some((a) => !a.resolved)
              ? "Resolve every comment first. Annotations belong to a version, so publishing would leave them behind."
              : undefined
          }
        />
      ) : (
        <ViewerToolbar
          title={doc.title}
          folderId={doc.meta?.folderId ?? null}
          folders={folders}
          versionLabel={doc.currentVersion}
          peers={presence.peers}
          following={presence.following}
          onToggleFollow={presence.toggleFollow}
          commentsOpen={commentsOpen}
          onToggleComments={() => setCommentsOpen((v) => !v)}
          canEdit={canEdit}
          canShare={isOwner}
          onShare={() => setDialog("share")}
          editing={wantsEdit}
          onToggleEdit={() => void (wantsEdit ? stopEditing() : setWantsEdit(true))}
          offerTrust={liveTrust.shouldOffer}
          onOpenTrust={() => setDialog("trust")}
          onPresent={() => {
            setPresenting(true);
            void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
          menuEntries={menuEntries}
          pane={pane}
          onPane={setPane}
          singleColumn={singleColumn}
        />
      )}

      <ViewerBanners
        newVersion={live.newVersion}
        onOpenNewVersion={() => navigate(`/d/${docId}`)}
        onDismissNewVersion={live.dismissNewVersion}
        conflict={live.conflict}
        onTakeTheirs={() => {
          live.dismissConflict();
          frame.reload();
        }}
        onKeepMine={live.dismissConflict}
        orphanedCount={annotationLayer.orphaned.length}
        offerTrust={liveTrust.shouldOffer}
        onOpenTrust={() => setDialog("trust")}
        expiry={
          /* Shown once it HAS expired, and in the last week before — not for
             every future date, or a document set to expire next year carries a
             banner for eleven months and everybody stops reading banners. */
          doc.meta && expiryLabel(doc.meta.expiresAt)
            ? {
                label: expiryLabel(doc.meta.expiresAt) as string,
                expired: isExpired(doc.meta.expiresAt),
                isOwner,
              }
            : null
        }
        onOpenVisibility={() => setDialog("visibility")}
      />

      {/* One source of truth for "is the panel there", because the layout and
          the panel must agree — a version-less document renders no panel
          whatever the toggle says. */}
      <div className="viewer-body" data-comments={showComments ? "open" : "closed"}>
        <div className="doc-frame-wrap">
          {editingNow ? (
            <SlidePanel
              doc={frame.doc}
              epoch={frame.epoch}
              editable
              onChanged={() => frame.doc?.dispatchEvent(new Event("input", { bubbles: true }))}
            />
          ) : null}
          <iframe
            {...frame.frameProps}
            ref={frame.ref}
            className="doc-frame"
            title={doc.title}
          />
          <SelectionFab
            doc={frame.doc}
            epoch={frame.epoch}
            enabled={mode.kind === "reading"}
            label={user ? "Comment" : "Sign in to comment"}
            onComment={() => void startComment()}
          />
          {presenting ? (
            <button
              type="button"
              className="btn present-exit"
              onClick={() => {
                setPresenting(false);
                void document.exitFullscreen?.().catch(() => {});
              }}
            >
              Exit
            </button>
          ) : null}
        </div>

        {showComments ? (
          <Sidebar
            docId={docId}
            versionId={doc.currentVersion}
            annotations={annotations}
            orphaned={annotationLayer.orphaned}
            selectedId={selectedId}
            canComment={signedIn}
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
            members: doc.meta.members,
          }}
          teams={teams}
          isOwner={isOwner}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "visibility" && doc.meta ? (
        <VisibilityDialog
          docId={docId}
          current={{
            visibility: doc.meta.visibility ?? "private",
            publicEdit: doc.meta.publicEdit ?? false,
            linkToken: doc.meta.linkToken ?? null,
            expiresAt: expiryMs(doc.meta.expiresAt),
          }}
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

      {dialog === "stats" && doc.meta ? (
        <StatsPanel
          meta={doc.meta}
          canSeeDetail={isDocEditor}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "image" ? (
        <ImageExportDialog
          doc={frame.doc}
          title={doc.title}
          version={doc.currentVersion}
          user={emailLower}
          marking={doc.meta?.marking}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
