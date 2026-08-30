/**
 * copilot-auto — per-fingerprint request lease table.
 *
 * FetchPatch stamps the Copilot-Session-Token on outgoing chat POSTs. A
 * transport retry re-sends the SAME URL+body, so it must reuse the token
 * it was already stamped with (never a token queued for another session);
 * but two GENUINELY concurrent byte-identical requests (same prompt from
 * two sessions) are byte-identical too — indistinguishable from a retry
 * by payload alone. The table resolves the ambiguity with per-lease
 * liveness:
 *
 *   - a lease in state "in-flight" is an exchange still running: a new
 *     request with the same fingerprint must NOT reuse it — it consumes a
 *     fresh queued token and opens its own lease, so concurrent identical
 *     requests stamp distinct tokens (A and B, never A twice);
 *   - a lease in state "retryable" is a prior exchange that threw or
 *     returned 429/5xx: a new byte-identical request is a transport retry
 *     of THAT exchange and reuses its token (FIFO across retryable
 *     leases) without consulting the queue;
 *   - a non-retryable completion (2xx/4xx≠429) removes exactly that
 *     lease, so a later byte-identical request is a new turn and takes a
 *     fresh queued token.
 *
 * If a new request is byte-identical and arrives after a retryable
 * response, it is indistinguishable from a retry and reuses the available
 * lease. That is safe for token leakage (the token was already stamped on
 * this exact payload); it only affects token reuse, never cross-session
 * stamping.
 *
 * The table is bounded (max 64 leases total; the oldest fingerprints are
 * evicted on overflow) and cleared on install/restore/compaction. Tokens
 * are conversation-scoped secrets and are NEVER logged.
 */

/** Bounded lifecycle of one stamped request under a fingerprint. */
type LeaseState = "in-flight" | "retryable";

/** One stamped request under a fingerprint. */
export interface RequestLease {
  /** The Copilot-Session-Token already stamped on this request. */
  readonly token: string;
  /** in-flight: exchange running — never reused. retryable: a prior
   *  exchange threw / returned 429/5xx — its retry may reuse the token. */
  state: LeaseState;
}

/** Total leases across all fingerprints (evict oldest on overflow). */
const MAX_LEASES = 64;

export class RequestLeaseTable {
  /** fingerprint (SHA-256 of method+URL+body) → its leases, in stamping
   *  order. Map preserves insertion order, so the oldest fingerprint is
   *  evicted first when the total lease count overflows. */
  private readonly leases = new Map<string, RequestLease[]>();
  private total = 0;

  /**
   * Reuse the first retryable lease for a fingerprint (FIFO) — a prior
   * attempt of THIS request that threw or returned 429/5xx. The lease is
   * marked in-flight again. Returns undefined when no lease exists or
   * every lease is still in-flight: a genuinely concurrent identical
   * request, which must consume a fresh queued token instead.
   */
  reuse(fingerprint: string): RequestLease | undefined {
    const list = this.leases.get(fingerprint);
    if (list === undefined) return undefined;
    const index = list.findIndex((lease) => lease.state === "retryable");
    if (index < 0) return undefined;
    const lease = list[index];
    lease.state = "in-flight";
    return lease;
  }

  /**
   * Open an in-flight lease for a fresh queued token under a fingerprint
   * (a new concurrent request). Returns the lease so the caller can mark
   * or release it when the exchange settles. Bounded: evicts the oldest
   * fingerprints when the total lease count would exceed MAX_LEASES.
   */
  hold(fingerprint: string, token: string): RequestLease {
    const lease: RequestLease = { token, state: "in-flight" };
    const list = this.leases.get(fingerprint);
    if (list !== undefined) list.push(lease);
    else this.leases.set(fingerprint, [lease]);
    this.total += 1;
    if (this.total > MAX_LEASES) this.evictOldest();
    return lease;
  }

  /** Keep a lease available for a retry (throw / 429 / 5xx). */
  makeRetryable(lease: RequestLease): void {
    lease.state = "retryable";
  }

  /** Spend a lease on a non-retryable completion (2xx/4xx≠429): removes
   *  ONLY this lease; concurrent siblings under the fingerprint survive. */
  release(fingerprint: string, lease: RequestLease): void {
    const list = this.leases.get(fingerprint);
    if (list === undefined) return;
    const index = list.indexOf(lease);
    if (index < 0) return;
    list.splice(index, 1);
    this.total -= 1;
    if (list.length === 0) this.leases.delete(fingerprint);
  }

  /** Drop every lease (install / restore / compaction). */
  clear(): void {
    this.leases.clear();
    this.total = 0;
  }


  private evictOldest(): void {
    const oldest = this.leases.keys().next().value;
    if (oldest === undefined) return;
    const list = this.leases.get(oldest);
    if (list !== undefined) this.total -= list.length;
    this.leases.delete(oldest);
  }
}
