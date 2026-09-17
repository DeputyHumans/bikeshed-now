// SPDX-License-Identifier: Apache-2.0
// Web entry point.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { AuthProvider } from "./auth";
import { ToastProvider } from "./components/Toast";
import { App } from "./App";
import { FONT_FACE_CSS } from "./brand/fonts";
import "./styles/index.css";

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
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
