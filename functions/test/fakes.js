// SPDX-License-Identifier: Apache-2.0
// An in-memory Firestore and Auth for driving real endpoints in tests (SPEC §12).

const { createHash, randomBytes } = require("node:crypto");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

/**
 * Enough of Firestore to run an endpoint end to end: document refs, dotted
 * updates, field sentinels, chained equality `where` with `limit` and
 * `count`, batches, and transactions that read before they write.
 *
 * It is deliberately strict where Firestore is: a `create` over an existing
 * document fails, an `update` of a missing one fails, and a transaction that
 * reads after it has written throws, as the real one does. A fake looser than
 * the real thing is how a test passes while the bug is live.
 */
function fakeFirestore(initial = {}) {
  const store = new Map();
  for (const [path, data] of Object.entries(initial)) store.set(path, clone(data));
  let autoId = 0;

  const isSentinel = (v, kind) => v instanceof FieldValue && v.isEqual(kind);
  const DELETE = FieldValue.delete();
  const STAMP = FieldValue.serverTimestamp();

  /** Resolve sentinels against what is there, writing `value` at a dotted path. */
  function put(target, dotted, value) {
    const parts = dotted.split(".");
    let node = target;
    for (const p of parts.slice(0, -1)) {
      if (node[p] == null || typeof node[p] !== "object") node[p] = {};
      node = node[p];
    }
    const last = parts[parts.length - 1];
    if (isSentinel(value, DELETE)) delete node[last];
    else node[last] = resolve(value);
  }
  function resolve(value) {
    if (isSentinel(value, STAMP)) return admin.firestore.Timestamp.now();
    if (value instanceof FieldValue) throw new Error("fake: unsupported sentinel");
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object" && value.constructor === Object) {
      const out = {};
      for (const [k, v] of Object.entries(value)) if (!isSentinel(v, DELETE)) out[k] = resolve(v);
      return out;
    }
    return value;
  }
  function merge(base, data) {
    const out = clone(base ?? {});
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && v.constructor === Object && out[k] && typeof out[k] === "object") {
        out[k] = merge(out[k], v);
      } else put(out, k, v);
    }
    return out;
  }

  function apply(w) {
    const exists = store.has(w.path);
    switch (w.op) {
      case "create":
        if (exists) throw new Error(`fake: ${w.path} already exists`);
        store.set(w.path, resolve(w.data));
        return;
      case "set":
        store.set(w.path, w.opts?.merge ? merge(store.get(w.path), w.data) : resolve(w.data));
        return;
      case "update": {
        if (!exists) throw new Error(`fake: no document to update at ${w.path}`);
        const next = clone(store.get(w.path));
        for (const [k, v] of Object.entries(w.data)) put(next, k, v);
        store.set(w.path, next);
        return;
      }
      case "delete":
        store.delete(w.path);
        return;
    }
  }

  function snap(path) {
    const data = store.get(path);
    return {
      id: path.split("/").pop(),
      exists: data !== undefined,
      ref: ref(path),
      data: () => (data === undefined ? undefined : clone(data)),
      get: (field) => (data === undefined ? undefined : field.split(".").reduce((n, k) => n?.[k], data)),
    };
  }

  function ref(path) {
    return {
      id: path.split("/").pop(),
      path,
      get: async () => snap(path),
      set: async (data, opts) => apply({ op: "set", path, data, opts }),
      update: async (data) => apply({ op: "update", path, data }),
      create: async (data) => apply({ op: "create", path, data }),
      delete: async () => apply({ op: "delete", path }),
      collection: (name) => collection(`${path}/${name}`),
    };
  }

  function query(path, filters = [], max = Infinity) {
    const depth = path.split("/").length + 1;
    const matches = () =>
      [...store.keys()]
        .filter((p) => p.startsWith(`${path}/`) && p.split("/").length === depth)
        .filter((p) => filters.every(([f, v]) => snap(p).get(f) === v))
        .slice(0, max)
        .map(snap);
    const q = {
      where: (field, op, value) => {
        if (op !== "==") throw new Error(`fake: only == is supported, not ${op}`);
        return query(path, [...filters, [field, value]], max);
      },
      limit: (n) => query(path, filters, n),
      count: () => ({ get: async () => ({ data: () => ({ count: matches().length }) }) }),
      get: async () => {
        const docs = matches();
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      _matches: matches,
    };
    return q;
  }

  function collection(path) {
    return {
      ...query(path),
      doc: (id) => ref(`${path}/${id ?? `auto${++autoId}`}`),
    };
  }

  /** Queue writes on `target`, each method returning it so calls chain as Firestore's do. */
  function writer(target) {
    const writes = [];
    Object.assign(target, {
      create: (r, data) => (writes.push({ op: "create", path: r.path, data }), target),
      set: (r, data, opts) => (writes.push({ op: "set", path: r.path, data, opts }), target),
      update: (r, data) => (writes.push({ op: "update", path: r.path, data }), target),
      delete: (r) => (writes.push({ op: "delete", path: r.path }), target),
    });
    return writes;
  }

  const db = {
    collection,
    doc: (path) => ref(path),
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    batch() {
      const batch = {};
      const writes = writer(batch);
      batch.commit = async () => {
        for (const x of writes) {
          if (x.op === "create" && store.has(x.path)) throw new Error(`fake: ${x.path} already exists`);
        }
        for (const x of writes) apply(x);
      };
      return batch;
    },
    async runTransaction(fn) {
      const tx = {};
      const writes = writer(tx);
      Object.assign(tx, {
        async get(target) {
          if (writes.length > 0) throw new Error("fake: a transaction must read before it writes");
          return target._matches
            ? { docs: target._matches(), empty: target._matches().length === 0 }
            : snap(target.path);
        },
      });
      const result = await fn(tx);
      for (const x of writes) apply(x);
      return result;
    },
  };
  return { db, store };
}

function clone(v) {
  if (v instanceof admin.firestore.Timestamp) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}

/**
 * Replace `admin.firestore()` and `admin.auth()` for the length of `fn`.
 *
 * `firebase-admin` sets `__esModule`, so compiled code reaches the module
 * object itself and a property defined here is what it calls.
 */
async function withFakeAdmin({ db, sessions = {} }, fn) {
  const saved = ["firestore", "auth"].map((k) => [k, Object.getOwnPropertyDescriptor(admin, k)]);
  const firestore = Object.assign(() => db, admin.firestore);
  Object.defineProperty(admin, "firestore", { configurable: true, value: firestore });
  Object.defineProperty(admin, "auth", {
    configurable: true,
    value: () => ({
      verifySessionCookie: async (cookie) => {
        if (!sessions[cookie]) throw new Error("invalid session");
        return sessions[cookie];
      },
    }),
  });
  try {
    return await fn();
  } finally {
    for (const [k, d] of saved) if (d) Object.defineProperty(admin, k, d);
  }
}

/** A personal access token: the bearer string, and the record to seed for it. */
function fakeToken({ uid, email, channel }) {
  const tokenId = randomBytes(16).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  return {
    bearer: `bsk_${tokenId}.${secret}`,
    path: `tokens/${tokenId}`,
    record: {
      tokenId,
      uid,
      email,
      name: "test",
      channel,
      hash: createHash("sha256").update(secret).digest("hex"),
      revokedAt: null,
    },
  };
}

/** Call an onRequest function with a JSON body; resolve to what it sent. */
async function invoke(handler, { method = "POST", body = {}, headers = {} } = {}) {
  const req = {
    method,
    headers,
    body,
    query: {},
    path: "/",
    get: (h) => headers[h.toLowerCase()],
    header: (h) => headers[h.toLowerCase()],
  };
  return new Promise((resolveSent, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
        return this;
      },
      set(k, v) {
        return this.setHeader(k, v);
      },
      getHeader(k) {
        return this.headers[k.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(b) {
        resolveSent({ status: this.statusCode, body: b, headers: this.headers });
        return this;
      },
      send(b) {
        resolveSent({ status: this.statusCode, body: b, headers: this.headers });
        return this;
      },
      end() {
        resolveSent({ status: this.statusCode, body: undefined, headers: this.headers });
        return this;
      },
      on() {
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

module.exports = { fakeFirestore, withFakeAdmin, fakeToken, invoke };
