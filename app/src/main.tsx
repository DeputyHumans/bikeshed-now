// SPDX-License-Identifier: Apache-2.0
// Web entry point.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { AuthProvider } from "./auth";
import { ToastProvider } from "./components/Toast";
import { HomeLinkProvider } from "./viewer/homeLink";
import { App } from "./App";
import { FONT_FACE_CSS } from "./brand/fonts";
import { readProfile } from "./firestore";
import { setProfileReader } from "./people";
import "./styles/index.css";

// Names are read from profiles/{uid}; wired here so nothing else has to (people.ts).
setProfileReader(readProfile);

/**
 * The @font-face rule is injected from the same module the edit-iframe injector
 * uses, rather than written into a stylesheet. One definition, two consumers —
 * in the design this replaces the same font URL was pasted into two files and
 * they drifted.
 */
const fontStyle = document.createElement("style");
fontStyle.textContent = FONT_FACE_CSS;
document.head.appendChild(fontStyle);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          {/* Above the header and the pages both: a document says where the wordmark goes (SPEC §13). */}
          <HomeLinkProvider>
            <App />
          </HomeLinkProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
