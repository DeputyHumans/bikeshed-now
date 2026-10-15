// SPDX-License-Identifier: Apache-2.0
// The emulator debug logs a stack writes into its tree, periodically size-limited, and the Database emulator's own output kept beside the run's logs (SPEC §12).

/**
 * `firebase emulators:start` writes three debug logs into its working
 * directory, the stack's tree, with no size limit. Two shared stacks kept for
 * two days wrote 22 GB of firebase-debug.log and 10 GB of firestore-debug.log
 * each. Nothing in firebase-tools lowers them (measured on 15.25.1):
 *
 *   - `-Dgoogle.cloud_firestore.debug_log_level=FINE` is a literal in
 *     downloadableEmulators.js's Commands.firestore.args, with no flag,
 *     firebase.json key or environment variable around it; JAVA_TOOL_OPTIONS
 *     and JDK_JAVA_OPTIONS are read BEFORE the command line, so its FINE wins;
 *   - the File transport of firebase-debug.log (logger.js useFileLogger) is
 *     added on every command at level "debug", with no maxsize.
 *
 * So the logs are capped here, per stack:
 *
 *   firestore-debug.log, database-debug.log
 *       firebase-tools opens each with fs.createWriteStream(name) — mode "w",
 *       NOT append — and writes the JVM's output to it AND, line for line,
 *       to firebase-debug.log at level debug (_runBinary: logger.log("DEBUG",
 *       …)). A file written at its own offset cannot be truncated under its
 *       writer (the next write leaves a hole the size of everything before),
 *       and its content is already in firebase-debug.log, so before the
 *       emulators start each is a symlink to /dev/null (prepareDebugLogs).
 *   firebase-debug.log
 *       winston opens it with flags "a" (O_APPEND), so it can be cut in place:
 *       whenever it is over half the cap the stack's watchdog copies its last
 *       half-cap of bytes to firebase-debug.log.1 (replacing the previous one)
 *       and truncates it to 0 (capDebugLogs); the writer's next line lands at
 *       the new end. The first cut also keeps the file's first
 *       HEAD_BYTES as firebase-debug.head.log: the start-up lines (the
 *       command, the versions, the database's `database rules config:` binding) are
 *       written once and would otherwise be cut away.
 *
 * The cap is E2E_DEBUG_LOG_MAX_MB (200) per file; with the watchdog's poll
 * (15 s) no file passes it unless the emulators write more than half of it
 * between two polls.
 *
 * None of this touches logs/emulators.log, the emulator CLI's stdout, which is
 * what every reader in e2e/ reads (logs.mjs: the `[email] skipped` line,
 * function console lines; test.mjs functionKill), by byte offsets that a
 * rotation would break.
 *
 * THE DATABASE EMULATOR'S OWN LOG (drainDatabaseLog). With database-debug.log
 * at /dev/null, what the Database emulator (a JVM) prints survives only inside
 * firebase-debug.log, and that file does not outlive the stack:
 *
 *   - firebase-tools unlinks firebase-debug.log when the command exits with a
 *     code under 2 (bin/cli.js, process.on("exit")), which a clean SIGINT
 *     shutdown is: no stopped stack's tree has one;
 *   - each watchdog cut throws away everything but the newest half-cap;
 *   - the tree is deleted with the stack.
 *
 * So its records are copied out as they are written, to
 * e2e/.out/<runId>/logs/database-debug.log (rec.logs.database): the watchdog
 * drains the new bytes on every tick BEFORE it cuts, and stopStack drains once
 * more before it signals the emulators, hard-links firebase-debug.log into the
 * stack dir (pinDebugLog), and drains that link once they are gone, so the
 * emulator's shutdown lines are kept too. A record is one chunk of the JVM's
 * stdout or stderr as firebase-tools logs it (downloadableEmulators.js
 * _runBinary → EmulatorLogger.forEmulator("database").log("DEBUG", chunk)):
 *
 *   [debug] [<ISO>] <the chunk, over as many lines as it has> {"metadata":{"emulator":{"name":"database"},"message":"<the chunk>"}}
 *
 * The JSON trailer holds the chunk exactly. A trailer counts only when the
 * printed text IS that chunk: its last line before the trailer, and, as many
 * lines up as the chunk has line breaks, its first line after the
 * `[debug] [<ISO>] ` prefix. So a chunk that merely contains such JSON, or a
 * chunk line that looks like a record's first line, is never taken for one. Each line of a chunk is written with
 * the record's ISO time in front, `[2026-10-13T14:49:27.255Z] 07:49:27.255
 * [main] INFO …`, and every record starts a line of its own: the file is
 * what database-debug.log would have held, stdout and stderr in the order
 * they arrived, plus firebase-tools' own debug lines about the database (its
 * command line, the arguments it ignores), with dates a case can line up with
 * its own clock. A line the JVM's pipe split across two chunks shows as two
 * lines (each chunk's own time).
 * Only `[debug]` records are taken: the JVM's output is always logged at
 * debug, and firebase-tools' info and warn lines about the database are in
 * logs/emulators.log already. If an emulators:start were ever run with
 * --log-verbosity above DEBUG, the chunks would lose their trailer and this
 * file would stay empty (the harness passes no such flag).
 *
 * The drain's progress is <stackDir>/database-log.json: the byte offset read
 * to (always a line end), the file's inode and first bytes, the record being
 * read, and the output's committed size, under an O_EXCL lock with the
 * holder's pid, so the watchdog and stopStack never write a record twice. An
 * output longer than its committed size (a drain killed between its append
 * and its save) is cut back before the next append. A firebase-debug.log that
 * was cut or replaced (shorter than the offset, another inode, other first
 * bytes) is read from 0 again, after an `[e2e]` line saying what may be
 * missing. The output is held under the same cap as the debug logs: past half
 * of it the file moves to database-debug.log.1.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, renameSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assertPath } from "./paths.mjs";
import { isPidAlive } from "./ports.mjs";

export const DEBUG_LOG_MAX_DEFAULT_MB = 200;
/** firebase-tools' per-emulator logs (getLogFileName): content mirrored into firebase-debug.log. */
export const MIRRORED_LOGS = Object.freeze(["firestore-debug.log", "database-debug.log"]);
/** firebase-tools' own debug log, and the names it falls back to (logger.js findAvailableLogFile). */
export const CLI_LOGS = Object.freeze(["firebase-debug.log", ...Array.from({ length: 9 }, (_, i) => `firebase-debug.${i + 1}.log`)]);
export const HEAD_BYTES = 256 * 1024;
/** The Database emulator's own log, under e2e/.out/<runId>/logs/. */
export const DATABASE_LOG = "database-debug.log";
/** The drain's progress, in the stack dir (never in the tree, which capDebugLogs scans). */
export const DATABASE_LOG_STATE = "database-log.json";
/** The hard link to firebase-debug.log that stopStack makes before the emulators exit and unlink it. */
export const DEBUG_LOG_PIN = "firebase-debug.pinned.log";
/** One read of the drain; a line longer than this cannot be a record (a JVM chunk is at most 64 KB) and is skipped. */
export const DRAIN_CHUNK_BYTES = 1024 * 1024;
const FINGERPRINT_BYTES = 128;
const HEAD_CHARS = 256;
/** How many of the latest lines that begin like a record a drain remembers while a record is open. */
const STARTS_KEPT = 32;
const LEVEL_RE = /^\[(error|warn|info|http|verbose|debug|silly)\] /;
const DEBUG_AT_RE = /^\[debug\] \[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] /;
const EMULATOR_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The cap in bytes, from E2E_DEBUG_LOG_MAX_MB. */
export function debugLogMaxBytes(env = process.env) {
  const raw = env.E2E_DEBUG_LOG_MAX_MB;
  if (raw === undefined || raw === "") return DEBUG_LOG_MAX_DEFAULT_MB * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > DEBUG_LOG_MAX_DEFAULT_MB) throw new Error(`E2E_DEBUG_LOG_MAX_MB wants 1 to ${DEBUG_LOG_MAX_DEFAULT_MB}, got ${JSON.stringify(raw)}`);
  return Math.round(n * 1024 * 1024);
}

/** Before the emulators start: each mirrored log is a symlink to /dev/null. */
export function prepareDebugLogs(treeDir) {
  assertPath(treeDir, "treeDir");
  const out = [];
  for (const name of MIRRORED_LOGS) {
    const p = join(treeDir, name);
    try {
      unlinkSync(p);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    symlinkSync("/dev/null", p);
    out.push(p);
  }
  return out;
}

/** Copy the last `bytes` of `src` into `dest` (atomically: a tmp file renamed). */
function copyTail(src, dest, bytes) {
  const size = statSync(src).size;
  const from = Math.max(0, size - bytes);
  const tmp = `${dest}.${process.pid}.tmp`;
  const fdIn = openSync(src, "r");
  const fdOut = openSync(tmp, "w");
  try {
    const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, size - from)));
    let pos = from;
    while (pos < size) {
      const n = readSync(fdIn, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      writeSync(fdOut, buf, 0, n);
      pos += n;
    }
  } finally {
    closeSync(fdIn);
    closeSync(fdOut);
  }
  renameSync(tmp, dest);
  return size - from;
}

/** Copy the first `bytes` of `src` into `dest`, once. */
function keepHead(src, dest, bytes) {
  if (existsSync(dest)) return false;
  const fdIn = openSync(src, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fdIn, buf, 0, bytes, 0);
    const fdOut = openSync(dest, "wx");
    try {
      writeSync(fdOut, buf, 0, n);
    } finally {
      closeSync(fdOut);
    }
  } finally {
    closeSync(fdIn);
  }
  return true;
}

/**
 * Reduce every CLI debug log at each check: one over half `maxBytes` is
 * cut (see the header). Returns what it found and did, per file.
 * @returns {{file:string, size:number, rotated:boolean, keptBytes?:number, head?:boolean}[]}
 */
export function capDebugLogs(treeDir, { maxBytes = debugLogMaxBytes(), headBytes = HEAD_BYTES } = {}) {
  assertPath(treeDir, "treeDir");
  const half = Math.floor(maxBytes / 2);
  const out = [];
  for (const name of CLI_LOGS) {
    const p = join(treeDir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      out.push({ file: p, size: 0, rotated: false, link: st.isSymbolicLink() ? readlinkSync(p) : null });
      continue;
    }
    if (st.size <= half) {
      out.push({ file: p, size: st.size, rotated: false });
      continue;
    }
    const head = keepHead(p, join(treeDir, name.replace(/\.log$/, ".head.log")), Math.min(headBytes, half));
    const keptBytes = copyTail(p, `${p}.1`, half);
    truncateSync(p, 0);
    out.push({ file: p, size: st.size, rotated: true, keptBytes, head });
  }
  for (const name of MIRRORED_LOGS) {
    const p = join(treeDir, name);
    try {
      const st = lstatSync(p);
      out.push({ file: p, size: st.isFile() ? st.size : 0, rotated: false, link: st.isSymbolicLink() ? readlinkSync(p) : null });
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// An emulator's own output, out of firebase-debug.log

function checkEmulator(emulator) {
  if (typeof emulator !== "string" || !EMULATOR_RE.test(emulator)) throw new TypeError(`emulator: want a firebase-tools emulator name such as "database", got ${JSON.stringify(emulator)}`);
  return emulator;
}

/** The text that opens the JSON trailer of an `emulator`'s record in firebase-debug.log. */
export function emulatorTrailer(emulator = "database") {
  return `{"metadata":{"emulator":{"name":${JSON.stringify(checkEmulator(emulator))}}`;
}

/** The chunk a trailer holds, or null when `json` is not exactly one of `emulator`'s trailers. */
function trailerMessage(json, emulator) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const m = v && typeof v === "object" && !Array.isArray(v) ? v.metadata : null;
  if (!m || Object.keys(v).length !== 1 || m.emulator?.name !== emulator || typeof m.message !== "string") return null;
  return m.message;
}

function freshCursor() {
  return { line: 0, starts: [] };
}

/** Append a record's lines, each begun with the record's time; a record that does not end its last line gets a newline. */
function emitChunk(out, at, message) {
  const prefix = `[${at ?? "-"}] `;
  const body = message.endsWith("\n") ? message.slice(0, -1) : message;
  for (const line of body.split("\n")) out.push(prefix, line, "\n");
}

function lineBreaks(text) {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * The `emulator`'s own output in WHOLE lines of firebase-debug.log (the
 * header's format). `cursor` carries what a record that is still open needs
 * from one call to the next ({line, starts}: the lines read, and the last
 * STARTS_KEPT lines that began like a record, each {line, level, at, head});
 * null for the start of a file. A multi-line record is closed by its trailer
 * k lines below its first line, k being the line breaks in its chunk, so a
 * line inside a chunk that merely looks like a record's first line (`[info]
 * …`) cannot take its place. A text that does not end in "\n" has its last
 * line read as whole.
 * @returns {{text: string, records: number, cursor: {line: number, starts: {line: number, level: string, at: string|null, head: string}[]}}}
 */
export function emulatorLogText(text, { emulator = "database", cursor = null } = {}) {
  if (typeof text !== "string") throw new TypeError(`emulatorLogText: want the text of whole lines, got ${typeof text}`);
  checkEmulator(emulator);
  if (cursor !== null && (typeof cursor !== "object" || Array.isArray(cursor))) throw new TypeError("emulatorLogText: cursor is the previous call's cursor, or null");
  const marker = emulatorTrailer(emulator);
  const c = { line: Number.isInteger(cursor?.line) ? cursor.line : 0, starts: Array.isArray(cursor?.starts) ? cursor.starts.slice(-STARTS_KEPT) : [] };
  const out = [];
  let records = 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const at = c.line++;
    const idx = line.lastIndexOf(marker);
    const message = idx === -1 ? null : trailerMessage(line.slice(idx), emulator);
    const printed = message === null ? null : stripVTControlCharacters(message);
    // (1) the last line of a record whose first line came k lines before
    if (printed !== null && printed.includes("\n") && line.slice(0, idx) === `${printed.slice(printed.lastIndexOf("\n") + 1)} `) {
      const first = c.starts.find((x) => x.line === at - lineBreaks(printed));
      if (first && first.head === printed.slice(0, printed.indexOf("\n")).slice(0, HEAD_CHARS)) {
        if (first.level === "debug") {
          emitChunk(out, first.at, message);
          records++;
        }
        c.starts = [];
        continue;
      }
    }
    // (2) a line that begins like a record
    let prefixLen = -1;
    if (line.charCodeAt(0) === 91) {
      const lv = LEVEL_RE.exec(line);
      if (lv) {
        const d = lv[1] === "debug" ? DEBUG_AT_RE.exec(line) : null;
        prefixLen = (d ?? lv)[0].length;
        c.starts.push({ line: at, level: lv[1], at: d ? d[1] : null, head: line.slice(prefixLen, prefixLen + HEAD_CHARS) });
        if (c.starts.length > STARTS_KEPT) c.starts.shift();
      }
    }
    // (3) a record on one line
    if (printed !== null && prefixLen >= 0 && !printed.includes("\n") && line.slice(prefixLen, idx) === `${printed} `) {
      const self = c.starts[c.starts.length - 1];
      if (self.level === "debug") {
        emitChunk(out, self.at, message);
        records++;
      }
      c.starts = [];
    }
  }
  return { text: out.join(""), records, cursor: c };
}

function readState(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && s.v === 1 && Number.isInteger(s.offset) && s.offset >= 0 ? s : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The O_EXCL lock beside the state file: its path, or null while a live process other than this one holds it. */
function takeLock(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return path;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let pid = NaN;
      try {
        pid = Number(readFileSync(path, "utf8").trim());
      } catch {}
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) return null;
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return null;
}

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

function readHead(fd, size) {
  const n = Math.min(size, FINGERPRINT_BYTES);
  const buf = Buffer.alloc(n);
  const got = n > 0 ? readSync(fd, buf, 0, n, 0) : 0;
  return buf.subarray(0, got);
}

/**
 * Copy the `emulator`'s records that firebase-debug.log (`source`) gained
 * since the last drain into `out`, as the header describes; `state` is the
 * progress file (its lock is `<state>.lock`). Synchronous.
 * @returns {{file: string, source: string, records: number, total: number|null, bytes: number|null, read: number, written: number, offset: number, size: number, reset: null|"cut"|"replaced", rotated: boolean, trimmed: number, skippedLines: number, busy?: true, missing?: true}}
 *   records: taken by this drain; total: by every drain into `out` so far;
 *   bytes: `out`'s size now; read: bytes of `source` read; offset: where the
 *   next drain starts; busy: another live process was draining (nothing
 *   done); missing: no `source` (nothing done).
 */
export function drainEmulatorLog({ source, out, state, emulator = "database", maxBytes = debugLogMaxBytes(), chunkBytes = DRAIN_CHUNK_BYTES, now = Date.now } = {}) {
  assertPath(source, "source");
  assertPath(out, "out");
  assertPath(state, "state");
  checkEmulator(emulator);
  if (!Number.isInteger(maxBytes) || maxBytes < 2) throw new TypeError(`drainEmulatorLog: maxBytes wants a whole number of bytes, at least 2, got ${maxBytes}`);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 64) throw new TypeError(`drainEmulatorLog: chunkBytes wants a whole number, at least 64, got ${chunkBytes}`);
  if (typeof now !== "function") throw new TypeError("drainEmulatorLog: now is a clock function");
  const base = { file: out, source, records: 0, total: null, bytes: null, read: 0, written: 0, offset: 0, size: 0, reset: null, rotated: false, trimmed: 0, skippedLines: 0 };
  const lock = takeLock(`${state}.lock`);
  if (!lock) return { ...base, busy: true };
  try {
    const prev = readState(state);
    let fd;
    try {
      fd = openSync(source, "r");
    } catch (err) {
      if (err.code === "ENOENT") return { ...base, offset: prev?.offset ?? 0, total: prev?.records ?? null, bytes: prev?.outBytes ?? null, missing: true };
      throw err;
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return { ...base, total: prev?.records ?? null, bytes: prev?.outBytes ?? null, missing: true };
      const size = Number(st.size);
      const ino = String(st.ino);
      const head = readHead(fd, size);
      let offset = prev?.offset ?? 0;
      let cursor = prev?.cursor && typeof prev.cursor === "object" ? { ...prev.cursor } : freshCursor();
      let reset = null;
      if (prev) {
        const prevHead = Buffer.from(prev.head ?? "", "base64");
        if (prev.ino !== ino) reset = "replaced";
        else if (size < prev.offset) reset = "cut";
        else if (prevHead.length > 0 && (head.length < prevHead.length || !head.subarray(0, prevHead.length).equals(prevHead))) reset = "cut";
      }
      // The output as last committed: a longer one holds an append whose save never came.
      let outBytes = fileSize(out);
      let trimmed = 0;
      if (prev && prev.out === out && Number.isInteger(prev.outBytes) && outBytes > prev.outBytes) {
        trimmed = outBytes - prev.outBytes;
        truncateSync(out, prev.outBytes);
        outBytes = prev.outBytes;
      }
      const half = Math.max(1, Math.floor(maxBytes / 2));
      let written = 0;
      let rotated = false;
      const append = (text) => {
        if (!text) return;
        const bytes = Buffer.byteLength(text);
        if (outBytes > 0 && outBytes + bytes > half) {
          renameSync(out, `${out}.1`);
          outBytes = 0;
          rotated = true;
        }
        mkdirSync(dirname(out), { recursive: true });
        appendFileSync(out, text);
        outBytes += bytes;
        written += bytes;
      };
      if (reset) {
        const lostFrom = prev.offset;
        cursor = freshCursor();
        offset = 0;
        if (lostFrom > 0) {
          append(`[${new Date(now()).toISOString()}] [e2e] firebase-debug.log was ${reset} after this file had read ${lostFrom} bytes of it (last read ${prev.at ?? "unknown"}); what the ${emulator} emulator printed between that read and the ${reset === "cut" ? "cut" : "replacement"} is not here\n`);
        }
      }
      let pos = offset;
      let records = 0;
      let skippedLines = 0;
      const buf = size > pos ? Buffer.alloc(Math.min(chunkBytes, size - pos)) : null;
      while (buf && pos < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        const view = buf.subarray(0, n);
        let from = 0;
        if (cursor.skipping) {
          const nl = view.indexOf(10);
          if (nl === -1) {
            pos += n;
            continue;
          }
          from = nl + 1;
          delete cursor.skipping;
          skippedLines++;
        }
        const last = view.lastIndexOf(10);
        if (last < from) {
          if (from > 0) {
            pos += from;
            continue;
          }
          if (n === buf.length && n === chunkBytes) {
            // A line longer than a whole read: no record is that long.
            cursor = { line: Number.isInteger(cursor.line) ? cursor.line : 0, starts: [], skipping: true };
            pos += n;
            continue;
          }
          break; // the last line is still being written
        }
        const r = emulatorLogText(view.toString("utf8", from, last + 1), { emulator, cursor });
        cursor = r.cursor;
        records += r.records;
        append(r.text);
        pos += last + 1;
      }
      const total = (prev?.records ?? 0) + records;
      writeState(state, {
        v: 1,
        emulator,
        source,
        out,
        ino,
        offset: pos,
        size,
        head: head.toString("base64"),
        outBytes,
        cursor,
        records: total,
        drains: (prev?.drains ?? 0) + 1,
        at: new Date(now()).toISOString(),
      });
      return { ...base, records, total, bytes: outBytes, read: pos - offset, written, offset: pos, size, reset, rotated, trimmed, skippedLines };
    } finally {
      closeSync(fd);
    }
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

/**
 * Where a stack's Database emulator log goes: `stack` is a stack record or a
 * local target's `stack` ({treeDir, stackDir, logs}). Null when it names no
 * tree, stack dir or logs (an older record without logs.database falls back
 * to emulators.log's directory).
 * @returns {{source: string, pinned: string, out: string, state: string} | null}
 */
export function databaseLogPaths(stack) {
  if (!stack || typeof stack !== "object") throw new TypeError("databaseLogPaths: want a stack record or a local target's stack");
  const out = stack.logs?.database ?? (stack.logs?.emulators ? join(dirname(stack.logs.emulators), DATABASE_LOG) : null);
  if (!stack.treeDir || !stack.stackDir || !out) return null;
  return {
    source: assertPath(join(stack.treeDir, "firebase-debug.log"), "source"),
    pinned: assertPath(join(stack.stackDir, DEBUG_LOG_PIN), "pinned"),
    out: assertPath(out, "database log"),
    state: assertPath(join(stack.stackDir, DATABASE_LOG_STATE), "state"),
  };
}

/**
 * Drain a stack's Database emulator records into its logs/database-debug.log
 * (drainEmulatorLog), from the tree's firebase-debug.log, or from the pinned
 * link once that is gone. Null when the stack names no such paths.
 */
export function drainDatabaseLog(stack, { maxBytes = null, chunkBytes = DRAIN_CHUNK_BYTES, now = Date.now } = {}) {
  const p = databaseLogPaths(stack);
  if (!p) return null;
  const source = !existsSync(p.source) && existsSync(p.pinned) ? p.pinned : p.source;
  return drainEmulatorLog({ source, out: p.out, state: p.state, emulator: "database", maxBytes: maxBytes ?? stack.debugLogs?.maxBytes ?? debugLogMaxBytes(), chunkBytes, now });
}

/**
 * Hard-link the tree's firebase-debug.log into the stack dir, so it outlives
 * firebase-tools' unlink at exit (one file, two names: the watchdog's cuts
 * and the drain see the same bytes). Replaces an earlier pin.
 * @returns {{pinned: string|null, reason?: string}}
 */
export function pinDebugLog(stack) {
  const p = databaseLogPaths(stack);
  if (!p) return { pinned: null, reason: "no paths" };
  try {
    unlinkSync(p.pinned);
  } catch {}
  try {
    linkSync(p.source, p.pinned);
    return { pinned: p.pinned };
  } catch (err) {
    return { pinned: null, reason: err.code === "ENOENT" ? "no firebase-debug.log" : err.message };
  }
}

/** Remove the pinned link (its bytes are drained by then). True when one was there. */
export function unpinDebugLog(stack) {
  const p = databaseLogPaths(stack);
  if (!p) return false;
  try {
    unlinkSync(p.pinned);
    return true;
  } catch {
    return false;
  }
}
