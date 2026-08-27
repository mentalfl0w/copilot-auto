/**
 * copilot-auto — FetchPatch tests.
 *
 * Verifies the DESIGN §6 contract: only POSTs to api.githubcopilot.com
 * chat endpoints get the Copilot-Session-Token, resolved from the body's
 * wire model id; /models/session, non-POSTs and garbage input pass
 * through untouched; existing headers (plain objects or Headers
 * instances) are preserved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchPatch, type TokenProvider } from "./fetch-patch.ts";

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function installMock(): { restore: () => void; seen: Array<{ input: string | URL | Request; init?: RequestInit }> } {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    seen,
  };
}

function stampingPatch(take: (id: string | undefined) => string | undefined): FetchPatch {
  const provider: TokenProvider = { takeTokenForWireModel: take };
  return new FetchPatch(provider, () => undefined);
}

test("stamps the session token only on copilot chat POSTs", async () => {
  const { restore, seen } = installMock();
  const patch = stampingPatch((id) => (id === "gpt-5.4" ? "tok-1" : undefined));
  try {
    patch.install();

    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    await fetch("https://api.githubcopilot.com/models/session", {
      method: "POST",
      body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
    });
    await fetch("https://api.githubcopilot.com/chat/completions", { method: "GET" });

    assert.equal(seen.length, 4);
    assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), "tok-1");
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), null);
    assert.equal(new Headers(seen[2].init?.headers).get("Copilot-Session-Token"), null); // /models/session excluded
    assert.equal(new Headers(seen[3].init?.headers).get("Copilot-Session-Token"), null); // GET excluded
    // The chat body is passed through untouched.
    assert.equal(String(seen[0].init?.body), JSON.stringify({ model: "gpt-5.4" }));
  } finally {
    patch.restore();
    restore();
  }
});

test("preserves existing headers, including Headers instances", async () => {
  const { restore, seen } = installMock();
  const patch = stampingPatch(() => "tok-2");
  try {
    patch.install();
    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer x", "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    assert.equal(seen.length, 1);
    const headers = new Headers(seen[0].init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer x");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("Copilot-Session-Token"), "tok-2");
  } finally {
    patch.restore();
    restore();
  }
});

test("patch falls through on unparseable input and never throws", async () => {
  const { restore, seen } = installMock();
  const patch = stampingPatch(() => "tok");
  try {
    patch.install();
    await fetch("not a url", { method: "POST", body: "x" });
    await fetch(new Request("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: "not json",
    }));
    assert.equal(seen.length, 2);
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), null);
  } finally {
    patch.restore();
    restore();
  }
});

test("restore puts the original fetch back", async () => {
  const { restore, seen } = installMock();
  const patch = stampingPatch(() => "tok");
  patch.install();
  patch.restore();
  await fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.4" }),
  });
  assert.equal(seen.length, 1);
  assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), null);
  restore();
});
test("install captures the CURRENT fetch, not the construction-time one", async () => {
  const first = installMock();
  const patch = stampingPatch(() => "tok");
  // Simulate OMP core wrapping fetch after the extension was constructed.
  const second = installMock();
  try {
    patch.install();
    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    // The request flows through the patch into the SECOND wrapper — the
    // construction-time one is bypassed, preserving the host chain.
    assert.equal(second.seen.length, 1);
    assert.equal(first.seen.length, 0);
    assert.equal(new Headers(second.seen[0].init?.headers).get("Copilot-Session-Token"), "tok");

    patch.restore();
    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    // Restore puts the CURRENT wrapper back (no token — patch is gone).
    assert.equal(second.seen.length, 2);
    assert.equal(new Headers(second.seen[1].init?.headers).get("Copilot-Session-Token"), null);
  } finally {
    patch.restore();
    second.restore();
    first.restore();
  }
});

// ── retry lease (DESIGN hardening: a retried chat POST must reuse its
// ── OWN token, never a token queued for another session) ─────────────

/** Mock whose behaviors play out per call; a behavior may throw. */
function sequencedMock(
  behaviors: Array<() => Response | Promise<Response>>,
): { restore: () => void; seen: Array<{ input: string | URL | Request; init?: RequestInit }> } {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, init });
    const behavior = behaviors[Math.min(index, behaviors.length - 1)];
    index += 1;
    return await behavior();
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    seen,
  };
}

const CHAT = "https://api.githubcopilot.com/chat/completions";

test("retried chat POST reuses its own token, never another session's queued token", async () => {
  const { restore, seen } = sequencedMock([
    () => new Response("{}", { status: 429 }),
    () => new Response("{}", { status: 200 }),
    () => new Response("{}", { status: 200 }),
  ]);
  let takes = 0;
  // Simulates the FIFO queue: session A's token first, session B's second.
  const patch = stampingPatch(() => {
    takes += 1;
    return takes === 1 ? "tok-A" : "tok-B";
  });
  try {
    patch.install();
    const body = JSON.stringify({ model: "claude-sonnet-4-6" });
    // First attempt consumes tok-A and gets a retryable 429 (lease kept).
    await fetch(CHAT, { method: "POST", body });
    // Retry of the SAME request: reuses tok-A. The provider is NOT
    // consulted, so a token queued for another session is never consumed.
    await fetch(CHAT, { method: "POST", body });
    // A different turn (new body) takes the next queued token.
    await fetch(CHAT, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "next turn" }] }),
    });
    assert.equal(seen.length, 3);
    assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), "tok-A");
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), "tok-A", "retry must reuse its own token");
    assert.equal(new Headers(seen[2].init?.headers).get("Copilot-Session-Token"), "tok-B");
    assert.equal(takes, 2, "the retry consumed no queued token");
  } finally {
    patch.restore();
    restore();
  }
});

test("lease is spent once the exchange completes non-retryably", async () => {
  const { restore, seen } = sequencedMock([
    () => new Response("{}", { status: 200 }),
    () => new Response("{}", { status: 200 }),
  ]);
  let takes = 0;
  const patch = stampingPatch(() => {
    takes += 1;
    return takes === 1 ? "tok-A" : "tok-B";
  });
  try {
    patch.install();
    const body = JSON.stringify({ model: "gpt-5.4" });
    await fetch(CHAT, { method: "POST", body }); // 200 → lease released
    // The same body arriving later is a NEW turn: it must take a fresh
    // queued token, never the consumed one.
    await fetch(CHAT, { method: "POST", body });
    assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), "tok-A");
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), "tok-B", "completed exchange spends the lease");
    assert.equal(takes, 2);
  } finally {
    patch.restore();
    restore();
  }
});

test("a thrown chat POST keeps its lease so the retry reuses its own token", async () => {
  const { restore, seen } = sequencedMock([
    () => {
      throw new Error("network down");
    },
    () => new Response("{}", { status: 200 }),
  ]);
  let takes = 0;
  const patch = stampingPatch(() => {
    takes += 1;
    return "tok-A";
  });
  try {
    patch.install();
    const body = JSON.stringify({ model: "gpt-5.4" });
    await assert.rejects(
      fetch(CHAT, { method: "POST", body }),
      /network down/,
    );
    await fetch(CHAT, { method: "POST", body });
    assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), "tok-A");
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), "tok-A");
    assert.equal(takes, 1, "the retry reused the leased token without a fresh take");
  } finally {
    patch.restore();
    restore();
  }
});

/** Mock whose responses open only after BOTH concurrent requests have
 *  entered it, so the first request cannot complete (and release its
 *  lease) before the second's lease decision has run — deterministically
 *  forcing the in-flight overlap a real network exhibits. Behaviors play
 *  out per call, in entry order. */
function gatedMock(
  behaviors: Array<() => Response | Promise<Response>>,
): { restore: () => void; seen: Array<{ input: string | URL | Request; init?: RequestInit }> } {
  const seen: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  const gate = Promise.withResolvers<void>();
  let entered = 0;
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, init });
    entered += 1;
    if (entered === 2) gate.resolve();
    await gate.promise;
    const behavior = behaviors[Math.min(index, behaviors.length - 1)];
    index += 1;
    return await behavior();
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    seen,
  };
}

test("concurrent byte-identical chat POSTs stamp distinct queued tokens, never the same lease", async () => {
  const { restore, seen } = gatedMock([
    () => new Response("{}", { status: 200 }),
    () => new Response("{}", { status: 200 }),
  ]);
  let takes = 0;
  // Simulates two sessions each queueing one token for the same model.
  const patch = stampingPatch(() => {
    takes += 1;
    return takes === 1 ? "tok-A" : "tok-B";
  });
  try {
    patch.install();
    const body = JSON.stringify({ model: "gpt-5.4" });
    // Both requests compute the SAME fingerprint and both are in flight
    // at once: request 1's lease must not be reused by request 2.
    await Promise.all([
      fetch(CHAT, { method: "POST", body }),
      fetch(CHAT, { method: "POST", body }),
    ]);
    assert.equal(seen.length, 2);
    const stamped = seen
      .map((entry) => new Headers(entry.init?.headers).get("Copilot-Session-Token"))
      .sort();
    assert.deepEqual(
      stamped,
      ["tok-A", "tok-B"],
      "each concurrent identical request consumes its own queued token — never A twice",
    );
    assert.equal(takes, 2);
  } finally {
    patch.restore();
    restore();
  }
});

test("a retry after a concurrent sibling reuses its OWN lease token, in FIFO order", async () => {
  const { restore, seen } = gatedMock([
    () => new Response("{}", { status: 429 }),
    () => new Response("{}", { status: 200 }),
    () => new Response("{}", { status: 200 }),
  ]);
  let takes = 0;
  const patch = stampingPatch(() => {
    takes += 1;
    return takes === 1 ? "tok-A" : "tok-B";
  });
  try {
    patch.install();
    const body = JSON.stringify({ model: "gpt-5.4" });
    await Promise.all([
      fetch(CHAT, { method: "POST", body }),
      fetch(CHAT, { method: "POST", body }),
    ]);
    assert.equal(seen.length, 2);
    // seen[0] entered the mock first (behavior 0 → 429) and seen[1] got
    // behavior 1 (200): the 429 request's lease stays retryable while the
    // 200's is spent. A later byte-identical request is indistinguishable
    // from a transport retry of the failed one, so it must reuse THAT
    // lease's token — never the sibling's, never a fresh queued token.
    const retried = await fetch(CHAT, { method: "POST", body });
    assert.equal(seen.length, 3);
    assert.equal(
      new Headers(seen[2].init?.headers).get("Copilot-Session-Token"),
      new Headers(seen[0].init?.headers).get("Copilot-Session-Token"),
      "the retry reuses the 429 request's own token",
    );
    assert.notEqual(
      new Headers(seen[2].init?.headers).get("Copilot-Session-Token"),
      new Headers(seen[1].init?.headers).get("Copilot-Session-Token"),
      "the retry never reuses a sibling's token",
    );
    assert.equal(takes, 2, "the retry consumed no fresh queued token");
  } finally {
    patch.restore();
    restore();
  }
});

test("stamps the session token on /responses chat POSTs to the individual Copilot host", async () => {
  const { restore, seen } = installMock();
  const patch = stampingPatch((id) => (id === "mai-code-1.1-flash" || id === "claude-sonnet-4-6" || id === "gpt-5.4" ? "tok-mai" : undefined));
  try {
    patch.install();

    // openai-responses chat goes to {baseUrl}/responses on the
    // account-specific host — the reported failure host family.
    await fetch("https://api.individual.githubcopilot.com/responses", {
      method: "POST",
      body: JSON.stringify({ model: "mai-code-1.1-flash" }),
    });
    // /v1/messages on the generic host (Anthropic SDK appends /messages).
    await fetch("https://api.githubcopilot.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    // /chat/completions on the generic host.
    await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    // Control endpoints stay excluded on BOTH hosts.
    await fetch("https://api.individual.githubcopilot.com/models/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    await fetch("https://api.individual.githubcopilot.com/models/session/intent", {
      method: "POST",
      body: JSON.stringify({}),
    });
    // Look-alike hostnames are never stamped (exact match, not suffix).
    await fetch("https://evil-api.githubcopilot.com/responses", {
      method: "POST",
      body: JSON.stringify({ model: "mai-code-1.1-flash" }),
    });

    assert.equal(seen.length, 6);
    assert.equal(new Headers(seen[0].init?.headers).get("Copilot-Session-Token"), "tok-mai");
    assert.equal(new Headers(seen[1].init?.headers).get("Copilot-Session-Token"), "tok-mai");
    assert.equal(new Headers(seen[2].init?.headers).get("Copilot-Session-Token"), "tok-mai");
    assert.equal(new Headers(seen[3].init?.headers).get("Copilot-Session-Token"), null); // /models/session excluded
    assert.equal(new Headers(seen[4].init?.headers).get("Copilot-Session-Token"), null); // /models/session/intent excluded
    assert.equal(new Headers(seen[5].init?.headers).get("Copilot-Session-Token"), null); // look-alike host excluded
  } finally {
    patch.restore();
    restore();
  }
});
