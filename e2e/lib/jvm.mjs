// SPDX-License-Identifier: Apache-2.0
// The heap cap of every Java process a stack starts, and how an emulator that ran out of it is named (SPEC §12).

/**
 * firebase-tools starts the Firestore and Database emulators, and the Storage
 * emulator's rules runtime, as `java … -jar <jar>`, found on PATH, with no
 * -Xmx. A JVM without one may grow to a quarter of physical memory: two
 * shared Firestore emulators kept for two days reached 17 GB each.
 *
 * So the emulator's PATH starts with `<stackDir>/bin`, which holds one file,
 * `java`: a shell script written per stack (javaWrapper) that picks the
 * emulator from the jar named in its arguments and execs the real JVM with
 *
 *   -Xmx<cap>                    firestore 2048m, database 1024m, any other 512m
 *                                (`--jvm-heap <role>=<size>` lowers one; never above)
 *   -XX:+ExitOnOutOfMemoryError  a JVM out of heap exits (code 3) instead of
 *                                thrashing in GC; firebase-tools then stops
 *                                the suite, or (the rules runtime) carries on
 *                                without it
 *   -XX:OnOutOfMemoryError=…     first appends "<role> <pid>" to <stackDir>/jvm/oom
 *   -XX:ErrorFile=<stackDir>/jvm/hs_err_pid%p.log
 *
 * and appends "<role> <pid> <cap>" to <stackDir>/jvm/started before the exec
 * (exec keeps the pid). `exec` keeps it the process firebase-tools spawned
 * and signals; nothing else about the emulator changes, and the rules
 * runtime's stdout, which firebase-tools reads as its protocol, is untouched.
 *
 * jvmFailures(rec) reads those two files: an emulator that ran out of memory
 * is named, with its cap, by readiness (stack.mjs), by `run` while specs run,
 * and by the stack's watchdog, which then marks the stack failed and stops it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPath } from "./paths.mjs";
import { isPidAlive } from "./ports.mjs";

/** The roles a JVM can have, and the jar that names each (an argument containing it). */
export const JVM_ROLES = Object.freeze(["firestore", "database", "other"]);
export const JVM_JARS = Object.freeze({ firestore: "cloud-firestore-emulator", database: "firebase-database-emulator" });

/** The default, and the most a stack may give each role, in MiB. */
export const JVM_HEAP_CEILING_MB = Object.freeze({ firestore: 2048, database: 1024, other: 512 });
export const JVM_HEAP_FLOOR_MB = 16;

/** Parse a heap size: `768`, `768m`, `2g` → MiB. */
export function parseHeapSize(text) {
  const m = /^(\d+)([mMgG]?)$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`a heap size is <n>, <n>m or <n>g, got ${JSON.stringify(text)}`);
  const n = Number(m[1]);
  return /g/i.test(m[2]) ? n * 1024 : n;
}

/**
 * The heap caps of a stack, from `--jvm-heap <role>=<size>` (repeatable).
 * Each role defaults to its ceiling; a value above the ceiling or below the
 * floor is refused, so the guarantee holds whatever is asked.
 * @returns {{firestore:number, database:number, other:number}} MiB
 */
export function jvmHeapConfig(list = []) {
  const out = { ...JVM_HEAP_CEILING_MB };
  const seen = new Set();
  for (const item of list) {
    const m = /^([a-z]+)=(.+)$/.exec(String(item));
    if (!m || !JVM_ROLES.includes(m[1])) throw new Error(`--jvm-heap wants <role>=<size> with role ${JVM_ROLES.join("|")}, got ${JSON.stringify(item)}`);
    if (seen.has(m[1])) throw new Error(`--jvm-heap ${m[1]} given twice`);
    seen.add(m[1]);
    const mb = parseHeapSize(m[2]);
    if (mb > JVM_HEAP_CEILING_MB[m[1]]) throw new Error(`--jvm-heap ${m[1]}=${m[2]} is above the ${JVM_HEAP_CEILING_MB[m[1]]}m ceiling for ${m[1]}`);
    if (mb < JVM_HEAP_FLOOR_MB) throw new Error(`--jvm-heap ${m[1]}=${m[2]} is below the ${JVM_HEAP_FLOOR_MB}m floor`);
    out[m[1]] = mb;
  }
  return out;
}

/** A stack's caps as given to startStack: null (every default) or {role: MiB}, checked against floor and ceiling. */
export function normalizeJvmHeap(heap = null) {
  const out = { ...JVM_HEAP_CEILING_MB };
  for (const [role, mb] of Object.entries(heap ?? {})) {
    if (!JVM_ROLES.includes(role)) throw new Error(`jvmHeap: no role ${JSON.stringify(role)} (${JVM_ROLES.join("|")})`);
    if (!Number.isInteger(mb) || mb < JVM_HEAP_FLOOR_MB || mb > JVM_HEAP_CEILING_MB[role]) throw new Error(`jvmHeap.${role} wants ${JVM_HEAP_FLOOR_MB} to ${JVM_HEAP_CEILING_MB[role]} MiB, got ${JSON.stringify(mb)}`);
    out[role] = mb;
  }
  return out;
}

/** <stackDir>/bin (the wrapper) and <stackDir>/jvm (what the wrapper records). */
export function jvmPaths(stackDir) {
  assertPath(stackDir, "stackDir");
  return { binDir: join(stackDir, "bin"), java: join(stackDir, "bin", "java"), jvmDir: join(stackDir, "jvm"), started: join(stackDir, "jvm", "started"), oom: join(stackDir, "jvm", "oom") };
}

/** A path that can sit inside the wrapper's single-quoted words and a JVM option (% is the JVM's own escape). */
function plainPath(p, label) {
  assertPath(p, label);
  if (/['"\\$`%\n]/.test(p)) throw new Error(`${label} cannot go into the java wrapper: ${p}`);
  return p;
}

/** The wrapper script's text (see the header). */
export function javaWrapper({ realJava, jvmDir, heap, runId = "" }) {
  plainPath(realJava, "real java");
  plainPath(jvmDir, "jvm dir");
  for (const r of JVM_ROLES) if (!Number.isInteger(heap?.[r]) || heap[r] < 1) throw new Error(`javaWrapper: heap.${r} is a whole number of MiB`);
  return [
    "#!/bin/sh",
    `# The java of e2e stack ${runId}: the real JVM with this stack's heap cap per emulator (e2e/lib/jvm.mjs).`,
    `real='${realJava}'`,
    `dir='${jvmDir}'`,
    `role=other heap=${heap.other}m probe=`,
    'for a in "$@"; do',
    '  case "$a" in',
    `    *${JVM_JARS.firestore}*) role=firestore heap=${heap.firestore}m ;;`,
    `    *${JVM_JARS.database}*) role=database heap=${heap.database}m ;;`,
    "    -version|--version) probe=1 ;;",
    "  esac",
    "done",
    '[ -n "$probe" ] || echo "$role $$ $heap" >> "$dir/started"',
    `exec "$real" "-Xmx$heap" -XX:+ExitOnOutOfMemoryError "-XX:OnOutOfMemoryError=echo $role %p >> '$dir/oom'" "-XX:ErrorFile=$dir/hs_err_pid%p.log" "$@"`,
    "",
  ].join("\n");
}

/** Write the stack's wrapper; returns the directory to put first on the emulator's PATH. */
export function installJavaWrapper({ stackDir, realJava, heap, runId }) {
  const p = jvmPaths(stackDir);
  mkdirSync(p.binDir, { recursive: true });
  mkdirSync(p.jvmDir, { recursive: true });
  writeFileSync(p.java, javaWrapper({ realJava, jvmDir: p.jvmDir, heap, runId }));
  chmodSync(p.java, 0o755);
  return p;
}

function lines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * What the wrapper recorded: every JVM it started ({role, pid, heap, alive})
 * and every one that ran out of memory ({role, pid}).
 */
export function jvmEvents(stackDir) {
  if (!stackDir || !existsSync(join(stackDir, "jvm"))) return { started: [], oom: [] };
  const p = jvmPaths(stackDir);
  const started = lines(p.started).map((l) => {
    const [role, pid, heap] = l.split(" ");
    return { role, pid: Number(pid), heap, alive: isPidAlive(Number(pid)) };
  }).filter((j) => JVM_ROLES.includes(j.role) && Number.isInteger(j.pid));
  const oom = lines(p.oom).map((l) => {
    const [role, pid] = l.split(" ");
    return { role, pid: Number(pid) };
  }).filter((j) => JVM_ROLES.includes(j.role));
  return { started, oom };
}

const EMULATOR_NAME = { firestore: "Firestore emulator", database: "Database emulator", other: "Storage rules runtime (or another JVM)" };

/**
 * The JVM failures of a stack, each naming the emulator: one that ran out of
 * memory, and (with `exited`) a Firestore or Database JVM that is gone.
 * @returns {{emulator:string, role:string, pid:number, reason:string}[]}
 */
export function jvmFailures(rec, { exited = true } = {}) {
  const { started, oom } = jvmEvents(rec?.stackDir);
  const out = [];
  const heapOf = (pid) => started.find((s) => s.pid === pid)?.heap ?? null;
  for (const o of oom) {
    out.push({ emulator: EMULATOR_NAME[o.role], role: o.role, pid: o.pid, reason: `the ${EMULATOR_NAME[o.role]} (pid ${o.pid}) ran out of memory: java.lang.OutOfMemoryError at its -Xmx${heapOf(o.pid) ?? "?"} cap` });
  }
  if (exited) {
    for (const s of started) {
      if (s.alive || s.role === "other" || oom.some((o) => o.pid === s.pid)) continue;
      out.push({ emulator: EMULATOR_NAME[s.role], role: s.role, pid: s.pid, reason: `the ${EMULATOR_NAME[s.role]} (pid ${s.pid}, -Xmx${s.heap}) exited` });
    }
  }
  return out;
}
