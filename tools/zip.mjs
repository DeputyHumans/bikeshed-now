// SPDX-License-Identifier: Apache-2.0
// The stored zip writer and reader the skill downloads use, which is the CLI's own (SPEC §19)

/**
 * One writer for the CLI and the build. It lives in `cli/src/zip.mjs` because
 * the published CLI ships only `src`; this module keeps the path the build
 * and the end-to-end harness have always imported. No shebang: Vite bundles
 * `app/vite.config.ts` and everything it imports.
 */

export { crc32, readStoredZip, storedZip } from "../cli/src/zip.mjs";
