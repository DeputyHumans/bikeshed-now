// SPDX-License-Identifier: Apache-2.0
// An in-memory Firestore and Auth for driving real endpoints in tests (SPEC §12).

const { createHash, randomBytes } = require("node:crypto");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

/**
 * Enough of Firestore to run an endpoint end to end: document refs, dotted
 * updates, field sentinels (delete, server timestamp, increment), chained
 * equality `where` with `limit` and `count`, batches, and transactions that
 * read before they write.
 *
 * It is deliberately strict where Firestore is: a `create` over an existing
 * document fails, an `update` of a missing one fails, and a transaction that
 * reads after it has written throws, as the real one does. A fake looser than
 * the real thing is how a test passes while the bug is live.
 */
function fakeFirestore(initial = {}) {
  const store = new Map();
  for (const [path, data] of Object.entries(initial)) store.set(path, clone(data));
  const revisions = new Map();
  let autoId = 0;

  const isSentinel = (v, kind) => v instanceof FieldValue && v.isEqual(kind);
  /** `FieldValue.increment(n)`, which adds to whatever number is there, or to 0. */
  const isIncrement = (v) => v instanceof FieldValue && typeof v.operand === "number";
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
    else if (isIncrement(value)) node[last] = (typeof node[last] === "number" ? node[last] : 0) + value.operand;
    else node[last] = resolve(value);
  }
  /**
   * The server's clock, strictly increasing: Firestore gives one document's
   * sequential commits increasing times, and a millisecond clock would tie a
   * burst of writes and order them by id instead.
   */
  let lastStamp = 0;
  function stamp() {
    const now = Date.now() * 1e6;
    lastStamp = Math.max(now, lastStamp + 1000);
    return new admin.firestore.Timestamp(Math.floor(lastStamp / 1e9), lastStamp % 1e9);
  }
  function resolve(value) {
    if (isSentinel(value, STAMP)) return stamp();
    if (isIncrement(value)) return value.operand;
    if (value instanceof FieldValue) throw new Error("fake: unsupported sentinel");
    if (Array.isArray(value)) return value.map(inArray);
    if (value && typeof value === "object" && value.constructor === Object) {
      const out = {};
      for (const [k, v] of Object.entries(value)) if (!isSentinel(v, DELETE)) out[k] = resolve(v);
      return out;
    }
    return value;
  }
  /** Firestore refuses every sentinel inside an array, however deep. */
  function inArray(value) {
    if (value instanceof FieldValue) throw new Error("fake: a FieldValue cannot be used inside an array");
    if (Array.isArray(value)) return value.map(inArray);
    if (value && typeof value === "object" && value.constructor === Object) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = inArray(v);
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
        break;
      case "set":
        store.set(w.path, w.opts?.merge ? merge(store.get(w.path), w.data) : resolve(w.data));
        break;
      case "update": {
        if (!exists) throw new Error(`fake: no document to update at ${w.path}`);
        const next = clone(store.get(w.path));
        for (const [k, v] of Object.entries(w.data)) put(next, k, v);
        store.set(w.path, next);
        break;
      }
      case "delete":
        store.delete(w.path);
        break;
    }
    revisions.set(w.path, (revisions.get(w.path) ?? 0) + 1);
  }

  /** Validate/apply the whole write set synchronously, restoring it on any refusal. */
  function commit(writes) {
    const before = new Map([...store].map(([p, d]) => [p, clone(d)]));
    const versions = new Map(revisions);
    try {
      for (const w of writes) apply(w);
    } catch (error) {
      store.clear();
      for (const [p, d] of before) store.set(p, d);
      revisions.clear();
      for (const [p, n] of versions) revisions.set(p, n);
      throw error;
    }
  }

  function snap(path) {
    const data = store.get(path);
    return {
      id: path.split("/").pop(),
      exists: data !== undefined,
      updateTime: data === undefined ? undefined : new admin.firestore.Timestamp(0, revisions.get(path) ?? 0),
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
      /** The collection holding it, whose own `parent` is the document above, as Firestore's is. */
      get parent() {
        const parts = path.split("/");
        const above = parts.slice(0, -2).join("/");
        return { id: parts[parts.length - 2], path: parts.slice(0, -1).join("/"), parent: above ? ref(above) : null };
      },
    };
  }

  function query(path, filters = [], max = Infinity, orders = [], after = null) {
    const depth = path.split("/").length + 1;
    /** Timestamps by their full precision, so two in one millisecond still order. */
    const key = (v) =>
      v instanceof admin.firestore.Timestamp ? v.seconds * 1e9 + v.nanoseconds : v && typeof v.toMillis === "function" ? v.toMillis() : v;
    /** A field, or the document's own id for `FieldPath.documentId()`, as Firestore orders by it. */
    const value = (p, field) => (field instanceof admin.firestore.FieldPath ? p.split("/").pop() : key(snap(p).get(field)));
    const compare = (a, b) => {
      for (const [field, dir] of orders) {
        const x = value(a, field);
        const y = value(b, field);
        if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    };
    const matches = () => {
      let paths = [...store.keys()]
        .filter((p) => p.startsWith(`${path}/`) && p.split("/").length === depth)
        .filter((p) =>
          filters.every(([f, op, v]) => {
            const got = snap(p).get(f);
            return op === "array-contains" ? Array.isArray(got) && got.includes(v) : got === v;
          }),
        );
      if (orders.length) paths.sort(compare);
      if (after) {
        // Strictly after the given values, in the query's own order.
        paths = paths.filter((p) => {
          for (let i = 0; i < orders.length && i < after.length; i++) {
            const [field, dir] = orders[i];
            const x = value(p, field);
            const y = after[i] instanceof admin.firestore.Timestamp ? key(after[i]) : after[i];
            if (x !== y) return (x > y) === (dir !== "desc");
          }
          return false;
        });
      }
      return paths.slice(0, max).map(snap);
    };
    const q = {
      where: (field, op, value) => {
        if (op !== "==" && op !== "array-contains") {
          throw new Error(`fake: only == and array-contains are supported, not ${op}`);
        }
        return query(path, [...filters, [field, op, value]], max, orders, after);
      },
      limit: (n) => query(path, filters, n, orders, after),
      orderBy: (field, dir = "asc") => query(path, filters, max, [...orders, [field, dir]], after),
      startAfter: (...values) => query(path, filters, max, orders, values),
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
      async add(data) {
        const document = ref(`${path}/auto${++autoId}`);
        await document.create(data);
        return document;
      },
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
      batch.commit = async () => commit(writes);
      return batch;
    },
    async runTransaction(fn, { maxAttempts = 5 } = {}) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tx = {};
        const writes = writer(tx);
        const reads = new Map();
        const queries = [];
        const version = (p) => revisions.get(p) ?? 0;
        // Include membership and revisions: an inserted/deleted matching row
        // conflicts too, including a query that was empty when read.
        const queryVersion = (q) => JSON.stringify(q._matches().map((s) => [s.ref.path, version(s.ref.path)]));
        Object.assign(tx, {
          async get(target) {
            if (writes.length > 0) throw new Error("fake: a transaction must read before it writes");
            if (target._matches) {
              const docs = target._matches();
              queries.push([target, queryVersion(target)]);
              return { docs, empty: docs.length === 0 };
            }
            if (!reads.has(target.path)) reads.set(target.path, version(target.path));
            return snap(target.path);
          },
        });
        const result = await fn(tx);
        if ([...reads].some(([p, v]) => version(p) !== v) || queries.some(([q, v]) => queryVersion(q) !== v)) continue;
        commit(writes);
        return result;
      }
      throw Object.assign(new Error("fake: transaction contention exhausted retries"), { code: 10 });
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
async function withFakeAdmin({ db, sessions = {}, idTokens = {}, users = {} }, fn) {
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
      verifyIdToken: async (token) => {
        if (!idTokens[token]) throw new Error("invalid id token");
        return idTokens[token];
      },
      createSessionCookie: async (token) => `cookie-for-${token}`,
      // A user record, as the gate re-check at refresh reads it. An Error in
      // the map is thrown, so a failing Auth backend can be staged.
      getUser: async (uid) => {
        const user = typeof users === "function" ? users(uid) : users[uid];
        if (user instanceof Error) throw user;
        if (!user) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
        return user;
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

/**
 * Call an onRequest function with a JSON body; resolve to what it sent.
 *
 * `rawBody` is the bytes as they arrived, which is what a handler that must
 * not trust the framework's own body parsing reads.
 */
async function invoke(handler, { method = "POST", body = {}, headers = {}, path = "/", query = {}, rawBody } = {}) {
  const req = {
    method,
    headers,
    body,
    rawBody,
    query,
    path,
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
