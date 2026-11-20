// SPDX-License-Identifier: Apache-2.0
// The upload dialog says what publishing will do, file by file, and never publishes over a version nobody saw (SPEC §2, §6a).

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UploadVersionDialog, versionUploadMessage } from "./UploadVersionDialog";
import { ToastProvider } from "./Toast";
import type { SendControl, VersionUploadResult } from "../upload";
import type { BaseFiles, Pick, Plan } from "../bundleInput";

/**
 * The transport is the client's business (upload.test.ts); this is about what
 * the dialog sends and says. `vi.hoisted` because the mock factory is hoisted
 * above everything else in the file.
 */
const { publishVersion, getVersion } = vi.hoisted(() => ({
  publishVersion: vi.fn(
    async (_plan: Plan, _opts: { docId: string; baseVersion: string } & SendControl): Promise<VersionUploadResult> => ({
      docId: "d1", versionId: "v5", contentHash: "h", fileCount: 3, bytes: 9, deduped: false,
    }),
  ),
  getVersion: vi.fn(async () => ({ versionId: "v4", entry: "index.html", format: "html", files: ["index.html", "img/chart.png"] })),
}));
vi.mock("../upload", async (importActual) => ({ ...(await importActual<typeof import("../upload")>()), publishVersion }));
vi.mock("../firestore", () => ({ getVersion }));

const FILE = new File(["<p>Hi</p>"], "deck.html", { type: "text/html" });
const BASE: BaseFiles = { files: ["img/chart.png", "index.html", "style.css"], entry: "index.html", format: "html" };
const filePick = (...files: File[]): Pick => ({ files: files.map((file) => ({ path: file.name, file })), leftOut: [], folder: null, fromFolder: false });
const folderPick = (paths: string[], leftOut: string[] = []): Pick => ({
  files: paths.map((path) => ({ path: `site/${path}`, file: new File(["x"], path.split("/").pop()!) })),
  leftOut, folder: "site", fromFolder: true,
});

type Props = Parameters<typeof UploadVersionDialog>[0];
function dialog(props: Partial<Props> = {}) {
  const onPublished = vi.fn();
  const base: Props = {
    docId: "d1",
    title: "Q3 plan",
    headVersion: "v4",
    base: BASE,
    trusted: false,
    onClose: vi.fn(),
    onPublished,
    ...props,
  };
  const view = render(
    <ToastProvider>
      <UploadVersionDialog {...base} />
    </ToastProvider>,
  );
  const rerender = (next: Partial<Props>) =>
    view.rerender(
      <ToastProvider>
        <UploadVersionDialog {...base} {...next} />
      </ToastProvider>,
    );
  return { onPublished, onClose: base.onClose, rerender };
}

const publish = () => screen.getByRole("button", { name: /^(Publish|Publishing…)$/ }) as HTMLButtonElement;
const plan = () => document.querySelector(".upload-plan")?.textContent ?? "";
const choose = (...files: File[]) =>
  fireEvent.change(screen.getByLabelText("Choose files") as HTMLInputElement, { target: { files } });

beforeEach(() => {
  publishVersion.mockClear();
  getVersion.mockClear();
});

describe("UploadVersionDialog", () => {
  it("sends the chosen page on top of the version that was current when it opened", async () => {
    const { onPublished } = dialog();
    expect(publish().disabled).toBe(true);
    choose(FILE);
    expect(plan()).toContain("Replaces the page. The other 2 files stay as they are.");
    await act(async () => fireEvent.click(publish()));

    expect(publishVersion).toHaveBeenCalledTimes(1);
    const [sent, opts] = publishVersion.mock.calls[0];
    expect(sent).toMatchObject({ action: "page", file: FILE });
    expect(opts).toMatchObject({ docId: "d1", baseVersion: "v4" });
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v5" }));
  });

  it("starts from what was dropped onto the document", () => {
    dialog({ initialPick: filePick(FILE) });
    expect(screen.getByText("deck.html")).toBeTruthy();
    expect(publish().disabled).toBe(false);
  });

  it("says which file each loose one replaces, and which it adds, before anything is sent", () => {
    const chart = new File(["new"], "chart.png");
    const logo = new File(["svg"], "logo.svg");
    dialog({ initialPick: filePick(chart, logo) });
    expect(plan()).toContain("chart.png replaces img/chart.png");
    expect(plan()).toContain("logo.svg is added");
    expect(plan()).toContain("Every other file stays as it is.");
    expect(publish().disabled).toBe(false);
  });

  it("refuses to guess between two files of one name", () => {
    dialog({ base: { ...BASE, files: [...BASE.files, "old/chart.png"] }, initialPick: filePick(new File(["new"], "chart.png")) });
    expect(screen.getByRole("alert").textContent).toContain("2 files are called chart.png: img/chart.png, old/chart.png. Drop the folder instead, so it’s clear which one you mean.");
    expect(publish().disabled).toBe(true);
  });

  it("names the files a folder leaves out of the next version, and what it left out of the folder", () => {
    dialog({ initialPick: folderPick(["index.html", "style.css"], [".env", "node_modules/"]) });
    expect(plan()).toContain("The folder becomes the whole next version, so it removes a file the current version has:");
    expect(plan()).toContain("img/chart.png");
    expect(plan()).toContain("Left out: .env and node_modules/.");
  });

  it("reads what the current version holds when it was not given, before it says anything", async () => {
    dialog({ base: undefined, initialPick: filePick(new File(["new"], "chart.png")) });
    expect(plan()).toBe("");
    await waitFor(() => expect(plan()).toContain("chart.png replaces img/chart.png"));
    expect(getVersion).toHaveBeenCalledWith("d1", "v4");
  });

  it("will not send once somebody else has published, and says so", async () => {
    const { rerender } = dialog({ initialPick: filePick(FILE) });
    rerender({ headVersion: "v5" });
    expect(screen.getByRole("status").textContent).toContain("v5 was published while this was open");
    expect(publish().disabled).toBe(true);
    await act(async () => fireEvent.click(publish()));
    expect(publishVersion).not.toHaveBeenCalled();
  });

  it("will not send while somebody is in the editor, and names them", () => {
    dialog({ initialPick: filePick(FILE), editing: ["Ana"] });
    expect(screen.getByRole("status").textContent).toContain("Ana has it open in the editor");
    expect(publish().disabled).toBe(true);
  });

  it("names a draft that would be discarded and scripts that would be blocked, only when there are some", () => {
    const { rerender } = dialog();
    const notes = () => document.querySelector(".upload-notes")!.textContent ?? "";
    expect(notes()).toContain("Comments stay on v4");
    expect(notes()).not.toContain("unpublished edits");
    expect(notes()).not.toContain("scripts");

    rerender({ draftBy: "ana@example.com", trusted: true });
    expect(notes()).toContain("The unpublished edits Ana last saved are discarded.");
    expect(notes()).toContain("Its scripts are blocked again");
  });

  it("says what closing would do while sending, then while publishing", async () => {
    let control!: SendControl;
    let finish!: (r: VersionUploadResult) => void;
    publishVersion.mockImplementationOnce((_p, opts) => { control = opts; return new Promise((r) => (finish = r)); });
    const { onPublished } = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    act(() => control.onProgress?.(0.5));
    expect(screen.getByText(/Closing this stops the upload\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    act(() => control.onSent?.());
    expect(screen.getByText("Publishing. It finishes even if you close this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => finish({ docId: "d1", versionId: "v5", contentHash: "h", fileCount: 1, bytes: 1, deduped: false }));
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it("stops the upload when closed while sending, and never publishes after", async () => {
    let control!: SendControl;
    let finish!: (r: VersionUploadResult) => void;
    publishVersion.mockImplementationOnce((_p, opts) => { control = opts; return new Promise((r) => (finish = r)); });
    const { onPublished, onClose } = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(control.signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
    await act(async () => finish({ docId: "d1", versionId: "v5", contentHash: "h", fileCount: 1, bytes: 1, deduped: false }));
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("lets the head move to its own new version while it publishes, and reports the version", async () => {
    let control!: SendControl;
    let finish!: (r: VersionUploadResult) => void;
    publishVersion.mockImplementationOnce((_p, opts) => { control = opts; return new Promise((r) => (finish = r)); });
    const { onPublished, rerender } = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    act(() => control.onSent?.());
    // The document's listener sees the version this upload made before its answer arrives.
    rerender({ headVersion: "v5" });
    expect(screen.queryByText(/was published while this was open/)).toBeNull();
    expect(control.signal?.aborted).toBe(false);
    await act(async () => finish({ docId: "d1", versionId: "v5", contentHash: "h", fileCount: 1, bytes: 1, deduped: false }));
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it("never stops an upload whose bytes have all been sent: closing or leaving only stops listening", async () => {
    let control!: SendControl;
    publishVersion.mockImplementationOnce((_p, opts) => { control = opts; return new Promise(() => {}); });
    const view = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    act(() => control.onSent?.());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.onClose).toHaveBeenCalled();
    expect(control.signal?.aborted).toBe(false);
    cleanup();
    // Unmounting while publishing leaves the request alone too.
    expect(control.signal?.aborted).toBe(false);
  });

  it("is busy while the files are on their way, and stays open when it is refused", async () => {
    let refuse!: (e: Error) => void;
    publishVersion.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    const { onPublished } = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    expect(publish().getAttribute("aria-busy")).toBe("true");
    expect(publish().disabled).toBe(true);

    await act(async () => refuse(new Error("Somebody has this document open in the editor.")));
    await waitFor(() => expect(screen.getByText("Somebody has this document open in the editor.")).toBeTruthy());
    expect(onPublished).not.toHaveBeenCalled();
    expect(publish().getAttribute("aria-busy")).toBe("false");
  });

  it.each([
    "1 suggested edit is waiting for a decision.",
    "This document's unpublished draft holds 1 accepted suggestion.",
    "This document has expired — change or clear its expiry to edit it.",
    "You can no longer publish to this document.",
    "Somebody has this document open in the editor.",
  ])("keeps the files and enables retry after this specific refusal: %s", async (message) => {
    publishVersion.mockRejectedValueOnce(new Error(message));
    const { onPublished, onClose } = dialog({ initialPick: filePick(FILE) });
    await act(async () => fireEvent.click(publish()));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Upload a new version" })).toBeTruthy();
    expect(screen.getByText("deck.html")).toBeTruthy();
    expect(publish().disabled).toBe(false);
    expect(publish().getAttribute("aria-busy")).toBe("false");
    expect(onPublished).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("versionUploadMessage", () => {
  it("says nothing changed, or how many files did", () => {
    const result = { docId: "d1", versionId: "v2", contentHash: "h", fileCount: 1, bytes: 9 };
    expect(versionUploadMessage({ ...result, deduped: true })).toBe("No changes — it’s identical to v2.");
    expect(versionUploadMessage({ ...result, deduped: false })).toBe("Published v2.");
    expect(versionUploadMessage({ ...result, deduped: false, changes: { changed: 1, unchanged: 23, removed: 0 } })).toBe("Published v2 — 1 file changed, 23 unchanged.");
    expect(versionUploadMessage({ ...result, deduped: false, changes: { changed: 2, unchanged: 0, removed: 3 } })).toBe("Published v2 — 2 files changed, 3 removed.");
    expect(versionUploadMessage({ ...result, deduped: false, changes: { changed: 2, unchanged: 5, removed: 1 } })).toBe("Published v2 — 2 files changed, 1 removed, 5 unchanged.");
    expect(versionUploadMessage({ ...result, deduped: false, changes: { changed: 0, unchanged: 3, removed: 1 } })).toBe("Published v2 — 1 file removed, 3 unchanged.");
  });
});
