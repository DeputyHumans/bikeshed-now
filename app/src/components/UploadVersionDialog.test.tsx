// SPDX-License-Identifier: Apache-2.0
// The upload dialog says what publishing a file will do, and never publishes over a version nobody saw (SPEC §2, §6a).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UploadVersionDialog, versionUploadMessage } from "./UploadVersionDialog";
import { ToastProvider } from "./Toast";
import type { VersionUploadResult } from "../upload";

/**
 * The transport is the client's business (upload.test.ts); this is about what
 * the dialog sends and says. `vi.hoisted` because the mock factory is hoisted
 * above everything else in the file.
 */
const { uploadVersion } = vi.hoisted(() => ({
  uploadVersion: vi.fn(
    async (_file: File, _opts: { docId: string; baseVersion: string; onProgress?: (f: number) => void }): Promise<VersionUploadResult> => ({
      docId: "d1",
      versionId: "v5",
      contentHash: "h",
      fileCount: 1,
      bytes: 9,
      deduped: false,
    }),
  ),
}));
vi.mock("../upload", async (importActual) => ({ ...(await importActual<typeof import("../upload")>()), uploadVersion }));

const FILE = new File(["<p>Hi</p>"], "deck.html", { type: "text/html" });

type Props = Parameters<typeof UploadVersionDialog>[0];
function dialog(props: Partial<Props> = {}) {
  const onPublished = vi.fn();
  const base: Props = {
    docId: "d1",
    title: "Q3 plan",
    headVersion: "v4",
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
  return { onPublished, rerender };
}

const publish = () => screen.getByRole("button", { name: /^(Publish|Publishing…)$/ }) as HTMLButtonElement;
const choose = (file: File) =>
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });

beforeEach(() => uploadVersion.mockClear());

describe("UploadVersionDialog", () => {
  it("sends the chosen file on top of the version that was current when it opened", async () => {
    const { onPublished } = dialog();
    expect(publish().disabled).toBe(true);
    choose(FILE);
    await act(async () => fireEvent.click(publish()));

    expect(uploadVersion).toHaveBeenCalledTimes(1);
    expect(uploadVersion.mock.calls[0][0]).toBe(FILE);
    expect(uploadVersion.mock.calls[0][1]).toMatchObject({ docId: "d1", baseVersion: "v4" });
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v5" }));
  });

  it("starts from a file dropped onto the document", () => {
    dialog({ initialFile: FILE });
    expect(screen.getByText("deck.html")).toBeTruthy();
    expect(publish().disabled).toBe(false);
  });

  it("will not send once somebody else has published, and says so", async () => {
    const { rerender } = dialog({ initialFile: FILE });
    rerender({ headVersion: "v5" });
    expect(screen.getByRole("status").textContent).toContain("v5 was published while this was open");
    expect(publish().disabled).toBe(true);
    await act(async () => fireEvent.click(publish()));
    expect(uploadVersion).not.toHaveBeenCalled();
  });

  it("will not send while somebody is in the editor, and names them", () => {
    dialog({ initialFile: FILE, editing: ["Ana"] });
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
    expect(notes()).toContain("The unpublished edits ana@example.com last saved are discarded.");
    expect(notes()).toContain("Its scripts are blocked again");
  });

  it("is busy while the file is on its way, and stays open when it is refused", async () => {
    let refuse!: (e: Error) => void;
    uploadVersion.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    const { onPublished } = dialog({ initialFile: FILE });
    await act(async () => fireEvent.click(publish()));
    expect(publish().getAttribute("aria-busy")).toBe("true");
    expect(publish().disabled).toBe(true);

    await act(async () => refuse(new Error("Somebody has this document open in the editor.")));
    await waitFor(() => expect(screen.getByText("Somebody has this document open in the editor.")).toBeTruthy());
    expect(onPublished).not.toHaveBeenCalled();
    expect(publish().getAttribute("aria-busy")).toBe("false");
  });
});

describe("versionUploadMessage", () => {
  it("says nothing changed when the file is a version the document already has", () => {
    const result = { docId: "d1", versionId: "v2", contentHash: "h", fileCount: 1, bytes: 9 };
    expect(versionUploadMessage({ ...result, deduped: true })).toBe("No changes — the file is identical to v2.");
    expect(versionUploadMessage({ ...result, deduped: false })).toBe("Published v2.");
  });
});
