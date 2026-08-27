/**
 * copilot-auto — ConvStateStore tests.
 *
 * Session lifecycle per DESIGN §7: lazy open, seeding from the catalog
 * probe, single-flight dedup of concurrent opens, refresh 60s before
 * expiry, stale-token tolerance on failed refresh, compaction
 * invalidation, and the allConversations() iterator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvStateStore, DEFAULT_REFRESH_SKEW_MS } from "./conv-state-store.ts";
import { CapiClient } from "./capi-client.ts";
import type { AutoSession, LoggerLike } from "./types.ts";

const silentLogger: LoggerLike = { log: () => undefined };
const BASE = "https://api.githubcopilot.com";

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function withFetch(mock: FetchMock): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mock as unknown as typeof fetch; // test seam: replace the global fetch
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function session(overrides: Partial<AutoSession> = {}): AutoSession {
  return {
    selectedModelID: "gpt-5.4",
    sessionToken: "sess-tok",
    availableModels: ["gpt-5.4"],
    discountedCosts: {},
    expiresAtMs: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

function makeStore(): ConvStateStore {
  return new ConvStateStore(new CapiClient(silentLogger), silentLogger);
}

test("default refresh skew matches the design's 60s", () => {
  assert.equal(DEFAULT_REFRESH_SKEW_MS, 60_000);
});

test("ensureSession serves the seeded session without opening its own", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ session_token: "own", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    const seeded = session({ sessionToken: "seed-tok" });
    const got = await store.ensureSession("s1", "auto", BASE, "bearer", seeded);
    assert.equal(got, seeded);
    assert.equal(fetchCalls, 0);
    assert.equal(store.get("s1", "auto").session, seeded);
  } finally {
    restore();
  }
});

test("seed does not replace an existing session", async () => {
  const restore = withFetch(async () => {
    throw new Error("must not fetch");
  });
  try {
    const store = makeStore();
    const existing = session({ sessionToken: "existing" });
    store.get("s1", "auto").session = existing;
    const got = await store.ensureSession("s1", "auto", BASE, "bearer", session({ sessionToken: "seed" }));
    assert.equal(got, existing);
  } finally {
    restore();
  }
});

test("concurrent ensureSession calls share one in-flight session open", async () => {
  let fetchCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = withFetch(async () => {
    fetchCalls += 1;
    await gate;
    return jsonResponse({
      session_token: "tok",
      selected_model: "m",
      available_models: ["m"],
      expires_at: 1_900_000_000,
    });
  });
  try {
    const store = makeStore();
    const p1 = store.ensureSession("s1", "auto", BASE, "bearer");
    const p2 = store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(fetchCalls, 1, "both callers must share one open");
    release();
    const [s1, s2] = await Promise.all([p1, p2]);
    assert.equal(fetchCalls, 1);
    assert.equal(s1, s2);
    assert.equal(s1?.sessionToken, "tok");
  } finally {
    restore();
  }
});

test("seed works even when a session open is already in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = withFetch(async () => {
    await gate;
    return jsonResponse({ session_token: "own", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    const p1 = store.ensureSession("s1", "auto", BASE, "bearer");
    const seeded = session({ sessionToken: "seed" });
    const p2 = store.ensureSession("s1", "auto", BASE, "bearer", seeded);
    // The seed is assigned synchronously even while the open is pending.
    assert.equal(store.get("s1", "auto").session, seeded);
    release();
    const s1 = await p1;
    const s2 = await p2;
    assert.equal(s1?.sessionToken, "own"); // the in-flight open wins (fresher)
    assert.equal(s2?.sessionToken, "seed");
    assert.equal(store.get("s1", "auto").session?.sessionToken, "own");
  } finally {
    restore();
  }
});

test("ensureSession refreshes sessions inside the refresh skew", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ session_token: "fresh", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    // 30s to expiry < 60s skew → refresh instead of serving.
    store.get("s1", "auto").session = session({ sessionToken: "stale", expiresAtMs: Date.now() + 30_000 });
    const got = await store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(fetchCalls, 1);
    assert.equal(got?.sessionToken, "fresh");
  } finally {
    restore();
  }
});

test("failed refresh keeps serving the stale session (stale-token tolerance)", async () => {
  const restore = withFetch(async () => jsonResponse({ error: "boom" }, 500));
  try {
    const store = makeStore();
    const stale = session({ sessionToken: "stale", expiresAtMs: Date.now() + 30_000 });
    const conv = store.get("s1", "auto");
    conv.session = stale;
    const got = await store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(got, stale);
    assert.equal(conv.session, stale);
  } finally {
    restore();
  }
});

test("ensureSession with no bearer serves the cached session without fetching", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  });
  try {
    const store = makeStore();
    const s = session();
    store.get("s1", "auto").session = s;
    const got = await store.ensureSession("s1", "auto", BASE, undefined);
    assert.equal(got, s);
    assert.equal(fetchCalls, 0);
  } finally {
    restore();
  }
});

test("compaction invalidation targets one session; commits and iterators update state", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s2", "auto");
  a.session = session();
  a.routedModelID = "gpt-5.4";
  a.routedLabel = "needs_reasoning";

  store.markNeedsReEval("s1");
  assert.equal(a.needsReEval, true);
  assert.equal(b.needsReEval, undefined);

  store.commitRouting(a, "gpt-5.4", "no_reasoning", false, 0.9);
  assert.equal(a.routedModelID, "gpt-5.4");
  assert.equal(a.routedLabel, "no_reasoning");
  assert.equal(a.routedConfidence, 0.9);
  assert.equal(a.omitSessionToken, false);
  assert.equal(a.previousModel, "gpt-5.4");
  assert.equal(a.needsReEval, false);
  assert.equal(a.turn, 1);

  const seen = [...store.allConversations()];
  assert.equal(seen.length, 2);
  assert.ok(seen.includes(a) && seen.includes(b));

  assert.equal(store.inPool(a, "gpt-5.4"), true);
  assert.equal(store.inPool(a, "gemini-2.5-pro"), false);
  assert.equal(store.inPool(b, "gpt-5.4"), false); // no session yet
});
