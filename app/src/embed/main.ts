// SPDX-License-Identifier: Apache-2.0
// The embed page's entry point, which is never the app (SPEC §2 "GET /embed/…").

import "../styles/embed.css";
import { startEmbed } from "./embed";

// `docShell` writes both: the page's root, and the frame inside it, or no
// frame at all when the document is not available here.
const root = document.getElementById("embed");
const frame = document.getElementById("embed-frame");
if (root && frame instanceof HTMLIFrameElement) startEmbed(frame, root);
