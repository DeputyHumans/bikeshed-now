// SPDX-License-Identifier: Apache-2.0
// A title or an address is sent only when the uploader typed one (SPEC §4, §17).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UploadDialog } from "./UploadDialog";
import { ToastProvider } from "./Toast";
import { MARKING_OFF } from "../export/labels";
import type { UploadOptions, UploadResult } from "../upload";

/**
 * The dialog's own XHR-based client never runs in jsdom — this is about what
 * the dialog SENDS, not the transport — so `uploadDoc` is stubbed. `vi.hoisted`
 * because `vi.mock`'s factory is hoisted above every other statement in the
 * file, and a plain const would still be in the temporal dead zone. Typed with
 * the real signature (types only — erased before hoisting matters) so the
 * assertion on `opts.title` below is a checked one rather than a cast.
 */
const { uploadDoc } = vi.hoisted(() => ({
  uploadDoc: vi.fn(async (_file: File, _opts: UploadOptions): Promise<UploadResult> => ({
    docId: "d1",
    versionId: "v1",
    title: "Quarterly report",
    fileCount: 1,
    bytes: 128,
    format: "html",
  })),
}));

vi.mock("../upload", async () => {
  const actual = await vi.importActual<typeof import("../upload")>("../upload");
  return { ...actual, uploadDoc };
});

// Not the subject here, and logging for real would need the measurement id
// Vitest's env pins to empty — harmless either way, but a stub keeps this
// file's failures about the upload call alone.
vi.mock("../analytics", () => ({ logEvent: vi.fn() }));

function renderDialog() {
  return render(
    <ToastProvider>
      <UploadDialog
        folderId={null}
        accountDefaultMarking={MARKING_OFF}
        onClose={vi.fn()}
        onUploaded={vi.fn()}
      />
    </ToastProvider>,
  );
}

function chooseFile(name = "quarterly-report.html") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["<html><title>Q</title></html>"], name, { type: "text/html" });
  fireEvent.change(input, { target: { files: [file] } });
}

function clickUpload() {
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
}

beforeEach(() => {
  uploadDoc.mockClear();
});

describe("UploadDialog's title field", () => {
  it("stays empty once a file is chosen", () => {
    // The server now defaults an untitled upload's title to the document's own
    // <title> (Task 5). Prefilling from the FILE NAME here would mean a
    // browser upload never has an empty title to fall through from — that
    // default would never apply.
    renderDialog();
    chooseFile();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
  });

  it("sends no title when nothing was typed", async () => {
    renderDialog();
    chooseFile();
    clickUpload();

    await waitFor(() => expect(uploadDoc).toHaveBeenCalled());
    const opts = uploadDoc.mock.calls[0][1];
    expect(opts.title).toBeUndefined();
  });

  it("sends the typed title", async () => {
    renderDialog();
    chooseFile();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My doc" } });
    clickUpload();

    await waitFor(() => expect(uploadDoc).toHaveBeenCalled());
    const opts = uploadDoc.mock.calls[0][1];
    expect(opts.title).toBe("My doc");
  });
});

describe("UploadDialog's address field", () => {
  it("sends no id when nothing was typed, so the server derives one", async () => {
    renderDialog();
    chooseFile();
    clickUpload();

    await waitFor(() => expect(uploadDoc).toHaveBeenCalled());
    expect(uploadDoc.mock.calls[0][1].id).toBeUndefined();
  });

  it("sends the typed id, trimmed", async () => {
    renderDialog();
    chooseFile();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: " 01-platform " } });
    clickUpload();

    await waitFor(() => expect(uploadDoc).toHaveBeenCalled());
    expect(uploadDoc.mock.calls[0][1].id).toBe("01-platform");
  });
});

describe("UploadDialog while it uploads", () => {
  it("says the upload is working until the server has answered", async () => {
    // Past 100% of the bytes the server is still publishing; the bar sits full
    // and the button is what says the wait is not over.
    let finish!: () => void;
    uploadDoc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ docId: "d1", versionId: "v1" } as UploadResult);
        }),
    );
    renderDialog();
    chooseFile();
    clickUpload();

    const button = screen.getByRole("button", { name: "Uploading…" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    await act(async () => finish());
  });
});


describe("the file picker by keyboard", () => {
  it("offers the visible chooser without a second invisible tab stop", () => {
    renderDialog();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    expect(input.tabIndex).toBe(-1);
    fireEvent.click(screen.getByRole("button", { name: "Choose a file" }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});


describe("UploadDialog's arriving account default", () => {
  it("follows a late default until the person chooses, then keeps that explicit choice", async () => {
    const shown = (enabled: boolean, label: string) => <ToastProvider><UploadDialog folderId={null} accountDefaultMarking={{ enabled, label, footer: "Footer" }} onClose={vi.fn()} onUploaded={vi.fn()} /></ToastProvider>;
    const view = render(shown(false, ""));
    chooseFile();
    const checkbox = screen.getByLabelText(/Stamp exports/) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    view.rerender(shown(true, "Account label"));
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    view.rerender(shown(true, "Later label"));
    expect(checkbox.checked).toBe(false);
    clickUpload();
    await waitFor(() => expect(uploadDoc).toHaveBeenCalled());
    expect(uploadDoc.mock.calls[0][1].marking).toEqual({ enabled: false, label: "Account label", footer: "Footer" });
  });
});
