# copilot-auto

GitHub Copilot **auto**-session routing for **oh-my-pi (OMP)** and **Pi**: injects a single `github-copilot/auto` shell model, drives Copilot's auto-session endpoints (`POST /models/session`, `POST /models/session/intent`), and stamps the per-conversation `Copilot-Session-Token` onto outgoing chat requests. Instead of picking one Copilot catalog model up front, you select `github-copilot/auto` and let GitHub's router — plus this extension's endpoint-aware selection policy — pick the wire model per prompt.

The same bundled artifact (`dist/index.js`) runs under **both hosts** — OMP's Bun binary and Pi's Node.js/jiti loader. A small runtime compatibility layer (`src/runtime-compat.ts`) discriminates the hosts at load time (OMP injects a truthy `pi` self-reference on the extension API; Pi does not) and adapts the two surfaces that differ: the load-phase OAuth marker and the catalog view. Everything else — hooks, routing, the fetch-patch token stamping — is shared verbatim.

## How it works

```
you:  omp --model github-copilot/auto "explain this diff"   (or: pi --model github-copilot/auto …)
       │
   CopilotAuto (extension)
       ├─ load phase   registerProvider("github-copilot", [auto])
       │               — required BEFORE the host resolves --model / the
       │                 session model scope; the OAuth credential is
       │                 resolved lazily from stored host auth (provider id
       │                 unchanged; OMP gets an oauth marker, Pi inherits
       │                 its built-in Copilot OAuth — no marker)
       ├─ session_start  resolve bearer → probe POST /models/session →
       │                 re-anchor the shell model to the session pool's
       │                 endpoint family (openai-responses | openai-completions
       │                 | anthropic-messages + account-specific base URL)
       ├─ input / before_agent_start   capture prompt text + image count
       │                               (interactive editor vs RPC AgentSession)
       ├─ before_provider_request      per-turn routing:
       │     ensureSession (refresh ≤60s before expiry) →
       │     POST /models/session/intent (1s abort) → payload.model override
       │     + reasoning boost → queue this turn's session token
       ├─ FetchPatch      stamps Copilot-Session-Token on the chat POST
       │                  (per wire model, FIFO — one token per turn)
       ├─ session_before_compact   invalidate sticky routing, drop the
       │                           compacted conversation's queued tokens
       └─ session_shutdown         restore the fetch patch, clear the queue
```

All hooks are best-effort: a routing failure passes the original payload through untouched and never throws into the host.

## Prerequisites

- **oh-my-pi (OMP) or Pi** — the extension targets the shared extension API (`pi.on(...)`, `before_provider_request`, `session_start`, ...) implemented by both hosts.
- **GitHub Copilot OAuth** — an active Copilot subscription with the credential stored in the host (`/login github-copilot` in OMP or Pi). The extension reuses the stored OAuth through the unchanged `github-copilot` provider id — it ships **no** `models.yml` and **no** credential handling of its own.
- **Bun** (for build/test/typecheck of this repo) — no runtime dependencies; the shipped artifact runs under Node.js (Pi) without Bun.

## Install

### OMP

The extension entry is the built bundle `dist/index.js` (manifest: `package.json` → `"omp".extensions`), so build before linking:

```sh
cd copilot-auto
bun install        # devDependencies only (@types/bun, typescript)
bun run build      # → dist/index.js
```

Development link (OMP plugin manager):

```sh
omp plugin link /path/to/copilot-auto
```

Alternatively, add the built package to the extension list in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - copilot-auto
```

Restart OMP after installing or editing. Verification: `omp models find auto` should return exactly one model — `github-copilot/auto`.

OMP specifics: the load-phase registration carries a lightweight `oauth` marker because OMP's runtime `registerProvider` validates non-empty model lists as requiring `apiKey` or `oauth`. Credential resolution stays lazy through the unchanged provider id's **stored OMP OAuth** (`/login github-copilot`), and the session_start re-anchor additionally triggers OMP's **background catalog refresh** (`refreshInBackground`/`awaitBackgroundRefresh`) so pool ids map to the account's current endpoints.

### Pi

The same `dist/index.js` is loaded by Pi's Node.js/jiti extension loader (no Bun required). After npm publication:

```sh
pi install npm:copilot-auto      # add to ~/.pi/agent/settings.json
pi -e npm:copilot-auto           # try once without installing
```

or add the built package path to `settings.json`:

```json
{
  "packages": ["./copilot-auto"]
}
```

Pi specifics: Pi's `registerProvider` treats a supplied `oauth` as a COMPLETE OAuth implementation (login/refreshToken/getApiKey), so the load-phase registration deliberately ships **without** the OMP marker — Pi then composes its **built-in `github-copilot` OAuth provider** (`/login github-copilot` in Pi). The Pi catalog is read through `ctx.modelRegistry.getAll()` / `ctx.scopedModels` instead of OMP's `ctx.models.list()`; provider/id/api/baseUrl metadata is preserved, so endpoint-aware routing is identical. The fetch-patch token stamping uses only Node-safe APIs (global fetch, `node:fs`/`path`/`os`, Web Crypto) and works unchanged under Pi.

Pi load test (no Pi installation required — simulates Pi's loader with an isolated temp dir and no `@oh-my-pi`/`@earendil-works` packages):

```sh
node scripts/test-pi-load.mjs
```

## Usage

Select the auto model wherever the host asks for a model (OMP example):

```sh
omp --model github-copilot/auto
```

```yaml
# ~/.omp/agent/config.yml
model: github-copilot/auto
```

Pi equivalents: `pi --model github-copilot/auto` and `"model": "github-copilot/auto"` in `~/.pi/agent/settings.json`.

Per-turn routing (and the selected wire model id, label, confidence and source) is logged to `~/.omp/logs/copilot-auto.log` (or `~/.pi/logs/...` on Pi); the status bar shows `copilot-auto: ready (<family>)` and the routing target per turn. The `/copilot-auto` slash command shows the current endpoint anchor and credential state.

Usage accounting keeps working through the host: statistics are recorded under the original catalog model entry, so premium usage lands on the `github-copilot` provider. **Usage display is host-specific** — OMP provides `/usage show` and `omp usage --provider github-copilot`; Pi has no `omp usage` CLI and surfaces usage through its own commands/UI.

```
/usage show                  # OMP TUI
omp usage --provider github-copilot   # OMP CLI
```

### Optional `enabledModels` allowlist

The plugin registers its model under the builtin `github-copilot` provider, which the host merges onto its live catalog. If you already restrict the model picker with `enabledModels`, keep your existing entries (for example `openai-codex/*`, `opencode-go/*`) and add the auto model (config path is host-specific — OMP example shown):

```yaml
# ~/.omp/agent/config.yml (or project .omp/config.yml)
enabledModels:
  - openai-codex/*
  - opencode-go/*
  - github-copilot/auto
```

## Endpoint-aware routing

A Copilot auto session returns a pool of available wire models. The extension picks the anchor **endpoint** for the shell model first (one probe per session start), then routes each turn only inside that endpoint:

- **Endpoint families**: `openai-responses` (`/responses`), `openai-completions` (`/chat/completions`), `anthropic-messages` (`/v1/messages`).
- **Account-specific base URL**: the current Copilot GPT/MAI/Gemini catalog is served from `api.individual.githubcopilot.com`; the anthropic family lives on `api.githubcopilot.com`. Both hosts are recognized; CAPI control endpoints stay on the generic host.
- **Anchor selection**: pool ids are grouped by (wire API + normalized base URL) — catalog metadata first, then a conservative heuristic (claude → anthropic-messages, gemini → openai-completions, gpt/codex/mai → openai-responses). The family with the most pool members anchors the shell model.
- **Selection policy**: a pool id is eligible only when its chat endpoint equals the anchor's. Unknown ids (no catalog entry, no heuristic match) are never token-stamped; a responses-family id is never sent to a chat-completions transport and vice versa. Intent candidates from outside the anchor endpoint are dropped.
- **Reasoning boost** (only on `needs_reasoning` turns, keyed to the anchor family): anthropic → `thinking { enabled, budget_tokens }`, openai-completions → `reasoning_effort: high`, openai-responses → `reasoning { effort, summary }` (existing fields preserved; stale effort flags dropped).

Sticky routing remembers the previous verdict per conversation; session compaction invalidates it so a compacted conversation is re-evaluated.

## Session token injection

Neither host's extension API has a header-grade seam for chat requests (Pi documents `before_provider_headers`, but OMP does not — a single shared path beats two divergent ones), so the extension patches `globalThis.fetch` on both hosts (the same in-process convention OMP core ships; Pi's Node transports call the same global). The patch is Node-safe: only global fetch, `Headers`/`URL`/`TextEncoder`, `crypto.subtle` and `AbortSignal` are used. The patch:

- intercepts only `POST`s to the two Copilot chat hosts on supported chat paths — control endpoints (`/models/session`, `/models/session/intent`) and look-alike hosts pass through untouched;
- stamps the token queued for **this** turn's wire model (FIFO per model, session-tagged) — never a scan of conversation state, so concurrent sessions routing the same model each get their own conversation's token;
- reuses a token for byte-identical retries (lease per request fingerprint, released on error/429/5xx) instead of consuming another session's token;
- never logs tokens; failures fall through to the original fetch.

## Architecture

Object-oriented, dependency-inverted (smart-approve convention); every concern is a class:

```
CopilotAuto (orchestrator)           — hook wiring, prompt capture, lifecycle
 ├─ RuntimeCompat                    — runtime discriminator (OMP vs Pi), load-phase
 │                                    OAuth marker, catalog + credential adapters
 ├─ ProviderRegistrar                — load-phase github-copilot/auto registration
 │                                    + session_start re-anchor (bearer → probe → endpoint)
 ├─ CapiClient                       — POST /models/session + /models/session/intent
 ├─ ConvStateStore                   — per (sessionId × auto) session token + sticky routing
 ├─ IntentRouter                     — endpoint-aware pool selection + reasoning boost
 ├─ FetchPatch                       — globalThis.fetch patch stamping Copilot-Session-Token
 ├─ PendingTokenQueue                — FIFO per-wire-model token queue, session-tagged
 ├─ RequestLeaseTable                — retry lease for byte-identical chat POSTs
 └─ Logger / RotatingLog             — ~/.omp/logs/copilot-auto.log or ~/.pi/logs/...
```

No `@oh-my-pi` / `@earendil-works` import at build time: the host API is consumed through minimal structural interfaces (`types.ts`), so the same bundle loads under OMP (Bun) and Pi (Node.js/jiti) and the branch matrix is unit-testable without a running host.

## Limitations (honest scope)

- **OMP merge behavior**: `registerProvider` merges, it does not replace — the builtin Copilot catalog models remain in the registry next to `auto` (expected; the extension API cannot delete them, and an edu/student account cannot use them anyway). Hide them with the optional `enabledModels` allowlist above.
- **One direct endpoint family**: the shell model is a single endpoint (wire API + base URL). Models from other families in the pool are never routed token-stamped through this transport; serving multiple families simultaneously requires an additional proxy endpoint in front of the Copilot API.
- **Registration is per-host-session**: subagent/task runners that do not load extensions bypass routing and send the anchor catalog model directly (acceptable degradation — no extension, no auto).
- **Routing is best-effort**: intent-endpoint failures, probe timeouts or missing credentials leave the payload untouched (or, without a credential, leave the extension idle until the credential is re-enabled).

## Tests / build

```sh
bun test src        # node:test suites: orchestrator, registrar, runtime compat,
                    # intent router, fetch patch, capi client, conv state, token queue
bun run typecheck   # tsc --noEmit
bun run build       # bun build src/index.ts --outdir dist --target bun
node scripts/test-pi-load.mjs   # Pi-host simulation: loads dist/index.js with
                    # plain Node, isolated HOME, no @oh-my-pi/@earendil-works,
                    # asserts credential-less + marker-free load registration
```

## License

MIT
