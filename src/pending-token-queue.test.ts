/**
 * copilot-auto — PendingTokenQueue tests.
 *
 * FIFO per wire model, session-tagged entries, and the lifecycle clears:
 * clearForSession() drops only the compacted conversation's tokens (a
 * sibling session's queued tokens survive), clear() drops everything on
 * session shutdown. Tokens are consumed exactly once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingTokenQueue } from "./pending-token-queue.ts";

test("queue/take is FIFO per wire model and cross-session", () => {
  const q = new PendingTokenQueue();
  q.queue("claude-sonnet-4-6", "sess-A", "tok-A");
  q.queue("claude-sonnet-4-6", "sess-B", "tok-B");
  // Strict route order: A's token first, then B's.
  assert.equal(q.take("claude-sonnet-4-6"), "tok-A");
  assert.equal(q.take("claude-sonnet-4-6"), "tok-B");
  assert.equal(q.take("claude-sonnet-4-6"), undefined, "empty queue fails closed");
});

test("wire models are isolated; unknown/undefined models take nothing", () => {
  const q = new PendingTokenQueue();
  q.queue("gpt-5.4", "sess-A", "tok-gpt");
  assert.equal(q.take("claude-sonnet-4-6"), undefined);
  assert.equal(q.take(undefined), undefined);
  assert.equal(q.take("gpt-5.4"), "tok-gpt");
});

test("clearForSession drops only the compacted conversation's tokens", () => {
  const q = new PendingTokenQueue();
  q.queue("claude-sonnet-4-6", "sess-A", "tok-A");
  q.queue("claude-sonnet-4-6", "sess-B", "tok-B");
  q.queue("claude-sonnet-4-6", "sess-A", "tok-A2");
  q.queue("gpt-5.4", "sess-B", "tok-B-gpt");

  q.clearForSession("sess-A");

  // sess-A's tokens are gone; sess-B's survive in order (model queues too).
  assert.equal(q.take("claude-sonnet-4-6"), "tok-B");
  assert.equal(q.take("claude-sonnet-4-6"), undefined);
  assert.equal(q.take("gpt-5.4"), "tok-B-gpt");
});

test("clearForSession on an unknown session is a no-op", () => {
  const q = new PendingTokenQueue();
  q.queue("claude-sonnet-4-6", "sess-A", "tok-A");
  q.clearForSession("sess-ghost");
  assert.equal(q.take("claude-sonnet-4-6"), "tok-A");
});

test("clear drops everything (session shutdown)", () => {
  const q = new PendingTokenQueue();
  q.queue("claude-sonnet-4-6", "sess-A", "tok-A");
  q.queue("gpt-5.4", "sess-B", "tok-B");
  q.clear();
  assert.equal(q.take("claude-sonnet-4-6"), undefined);
  assert.equal(q.take("gpt-5.4"), undefined);
});
