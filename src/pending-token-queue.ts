/**
 * copilot-auto — pending Copilot-Session-Token queue.
 *
 * The routing hook queues one token per routed turn, right before the
 * payload is returned; the fetch patch consumes it at send-time (FIFO per
 * wire model) so concurrent sessions routing the same model each get
 * their own conversation's token — never a scan of conv state, never a
 * consumed token handed to a different request.
 *
 * Entries are tagged with the session that minted them so lifecycle
 * events can drop exactly the right tokens:
 *   - session_before_compact → clearForSession(): pre-compaction tokens
 *     must not stamp a post-compaction request;
 *   - session_shutdown → clear(): a dead session's tokens must not leak
 *     into the next session.
 * Tokens are conversation-scoped secrets and are NEVER logged.
 */

/** One queued token and the conversation it was minted for. */
interface QueuedToken {
  token: string;
  sessionId: string;
}

export class PendingTokenQueue {
  private readonly queues = new Map<string, QueuedToken[]>();

  /** Queue a token for one wire model id (FIFO per model). */
  queue(wireModelId: string, sessionId: string, token: string): void {
    const queue = this.queues.get(wireModelId);
    if (queue) queue.push({ token, sessionId });
    else this.queues.set(wireModelId, [{ token, sessionId }]);
  }

  /** Consume the next queued token for a wire model, or undefined when
   *  none is pending (fail closed: send unstamped rather than invent one). */
  take(wireModelId: string | undefined): string | undefined {
    if (!wireModelId) return undefined;
    const queue = this.queues.get(wireModelId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (queue.length === 0) this.queues.delete(wireModelId);
    return entry?.token;
  }

  /** Drop every queued token (session shutdown). */
  clear(): void {
    this.queues.clear();
  }

  /** Drop queued tokens minted by one conversation (compaction): tokens
   *  queued before the compact must never stamp a post-compaction
   *  request. Tokens of other conversations are preserved. */
  clearForSession(sessionId: string): void {
    for (const [wireModelId, queue] of this.queues) {
      const kept = queue.filter((entry) => entry.sessionId !== sessionId);
      if (kept.length === 0) this.queues.delete(wireModelId);
      else if (kept.length !== queue.length) this.queues.set(wireModelId, kept);
    }
  }

}
