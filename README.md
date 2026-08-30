# copilot-auto

GitHub Copilot **auto**-session routing for **oh-my-pi (OMP)** and **Pi**: injects a single `github-copilot/auto` shell model, drives Copilot's session-routing endpoints, and stamps the per-conversation `Copilot-Session-Token` onto outgoing chat requests. Instead of picking one Copilot catalog model up front, you select `github-copilot/auto` and let GitHub's router — plus this extension's endpoint-aware selection policy — pick the wire model per prompt.

The routing uses the **session/intent** two-step path (`POST /models/session` + `POST /models/session/intent`); the session response supplies the pool used for aliases and forced-model routing.

**Two token-injection strategies** exist. The **native provider** path is preferred: on OMP the extension registers an `OmpProviderConfig` (with `streamSimple` + `fetchDynamicModels`), and on Pi it wraps the host's base `PiProvider` via `wrapPiProvider`. Both inject the `Copilot-Session-Token` through request-local `options.headers`, keeping the token inside the host's own streaming pipeline. When the native stream bridge is unavailable (no `streamSimple` on OMP, no `getProvider` on Pi), the extension falls back to **FetchPatch** — a `globalThis.fetch` interception that stamps the token at the transport layer.

The same bundled artifact (`dist/index.js`) runs under **both hosts** — OMP's Bun binary and Pi's Node.js/jiti loader. A small runtime compatibility layer (`src/runtime-compat.ts`) discriminates the hosts at load time (OMP injects a truthy `pi` self-reference on the extension API; Pi does not) and adapts the two surfaces that differ: the load-phase OAuth marker and the catalog view. Everything else — hooks, routing, native provider registration — is shared.

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
       ├─ load phase (OMP)    resolve stored OAuth → probe pool →
       │                      register `auto` + `auto-<pool-model>` aliases
       │                      with native custom stream
       ├─ session_start       resolve bearer → probe POST /models/session →
       │                      re-anchor the shell model to the session pool's
       │                      endpoint family (openai-responses | openai-completions
       │                      | anthropic-messages + account-specific base URL)
       │                      + refresh dynamic OMP model snapshot
       ├─ session_start (Pi)   register native wrapper after host model scope
       │                      is available
       ├─ input / before_agent_start   capture prompt text + image count
       │                               (interactive editor vs RPC AgentSession)
       ├─ before_provider_request      per-turn routing (fallback hook path only;
       │                               native path: routing runs inside streamSimple):
       │     ensureSession (refresh ≤60s before expiry) →
       │     POST /models/session/intent (1s abort) → payload.model override
       │     + reasoning boost → queue this turn's session token
       ├─ native streamSimple/wrapPiProvider   per-turn session/intent routing:
       │     POST /models/session + intent → inject token via request-local options.headers
       ├─ FetchPatch (fallback only)   stamps Copilot-Session-Token on the chat POST
       │                               (per wire model, FIFO — one token per turn)
       ├─ session_before_compact   invalidate sticky/in-flight routing, drop
       │                           compacted conversation tokens and leases
       └─ session_shutdown / credential_disabled
                                   restore fetch, clear queues, credentials,
                                   and every cached conversation session
```

All hooks are best-effort: a routing failure passes the original payload through untouched and never throws into the host.

## Prerequisites

- **oh-my-pi (OMP) or Pi** — the extension targets the shared extension API (`pi.on(...)`, `before_provider_request`, `session_start`, ...) implemented by both hosts.
- **GitHub Copilot OAuth** — an active Copilot subscription with the credential stored in the host (`/login github-copilot` in OMP or Pi). The extension reuses the stored OAuth through the unchanged `github-copilot` provider id — it ships **no** `models.yml` and **no** credential handling of its own.
- **Bun** (for build/test/typecheck of this repo) — no runtime dependencies; the shipped artifact runs under Node.js (Pi) without Bun.

## Install

### OMP

The extension entry is host-specific: OMP loads `dist/omp.js` and Pi loads `dist/pi.js` (both are built from the shared core; `dist/index.js` remains the host-neutral core entry). The manifest is `package.json` → `"omp".extensions` / `"pi".extensions`.

```sh
cd copilot-auto
bun install        # devDependencies only (@types/bun, typescript)
bun run build      # → dist/index.js + dist/omp.js + dist/pi.js
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

Restart OMP after installing or editing. Verification:
`omp models find auto --extension ./dist/omp.js --no-extensions` should
return `github-copilot/auto` plus the current pool aliases when stored OAuth
is available.

OMP specifics: the load-phase registration carries a lightweight `oauth`
marker because OMP's runtime `registerProvider` validates non-empty model
lists as requiring `apiKey` or `oauth`. The OMP host entry performs a
load-phase pool probe through its AuthStorage when available, so startup
`--model github-copilot/auto-<real-model-id>` resolves before `session_start`.
`session_start` still re-resolves the bearer, refreshes the catalog, and
re-registers the complete native provider configuration. If load-phase
authentication or discovery is unavailable, only `github-copilot/auto` is
registered until the session can refresh the pool.

### Pi

The Pi host entry is `dist/pi.js`, loaded by Pi's Node.js/jiti extension loader. It imports the host-supplied `@earendil-works/pi-ai` bridge only in the Pi entry; the shared core remains host-neutral.

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

Pi specifics: Pi's `registerProvider` treats a supplied `oauth` as a COMPLETE OAuth implementation (login/refreshToken/getApiKey), so the load-phase registration deliberately ships **without** the OMP marker — Pi then composes its **built-in `github-copilot` OAuth provider** (`/login github-copilot` in Pi). The Pi catalog is read through `ctx.modelRegistry.getAll()` / `ctx.scopedModels` instead of OMP's `ctx.models.list()`; provider/id/api/baseUrl metadata is preserved, so endpoint-aware routing is identical. When Pi exposes a base `PiProvider` via `getProvider`, the extension wraps it with `wrapPiProvider` for native routing with request-local `Copilot-Session-Token` headers. The FetchPatch fallback uses only Node-safe APIs (global fetch, `node:fs`/`path`/`os`, Web Crypto) and works unchanged under Pi.

Pi load test (no Pi installation required — loads the host-neutral core without host packages and separately exercises the Pi entry with a minimal host bridge stub):

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

Per-turn routing (and the selected wire model id, label, confidence and source) is logged to `~/.omp/logs/copilot-auto.log` (or `~/.pi/logs/...` on Pi); the status bar shows `copilot-auto: ready (<family>)` or `copilot-auto: ready (native)` and the routing target per turn. The `/copilot-auto` slash command shows the current endpoint anchor and credential state.

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

The native provider path routes a concrete model with its own transport metadata. The fallback hook path keeps the original shell-model anchor because `before_provider_request` can change the model id but not the host transport.

- **Endpoint families**: `openai-responses` (`/responses`), `openai-completions` (`/chat/completions`), `anthropic-messages` (`/v1/messages`).
- **Session/intent routing**: catalog metadata is preferred, then conservative id heuristics. Candidates must be present in the Auto pool and have a known endpoint before receiving the session token.
- **Cache boundary**: the selected native model is sticky for the conversation and is re-evaluated after compaction or expiry. This follows the current VS Code Auto behavior and avoids unnecessary prompt-cache churn.
- **Account-specific base URL**: GPT/MAI/Gemini catalog entries may use `api.individual.githubcopilot.com`; Anthropic entries may use `api.githubcopilot.com`. Control endpoints use the generic Copilot host.

### Alias visibility

The host model picker shows `github-copilot/auto` plus one `github-copilot/auto-<real-model-id>` alias for each real model in the latest successful Auto pool. Aliases are exact: `auto-gpt-5.4` routes **only** to `gpt-5.4`. Pool changes remove stale aliases; catalog-only models and unknown-endpoint models are never displayed as aliases.

### Routing paths: session/intent

The extension uses the session/intent two-step routing path:

1. **Session** (`POST /models/session`): opens a session with a 15-second hard abort, returns `available_models` for aliases/forced routing, and `session_token` for credential stamping.
2. **Intent** (`POST /models/session/intent`): classifies the prompt with a 1-second hard abort, returns `chosen_model`/`selected_model`, `candidate_models`, `reasoning_bucket`/`predicted_label`, and `confidence`. When `reasoning_bucket` is present, it is authoritative for effort (`low`/`medium`/`high`); `predicted_label` is retained only as a label and as the high-effort fallback for label-only responses.

Both response dialects are parsed defensively. Observed fields such as `chosen_model`, `selected_model`, `candidate_models`, `reasoning_bucket`, `predicted_label`, and `confidence` are retained when present; a valid `reasoning_bucket` overrides any contradictory label.
### Copilot Chat request profile

CAPI control requests use the same static profile as the current Copilot Chat client: `Accept: application/json`, `Content-Type: application/json`, `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Version: vscode/1.107.0`, `Editor-Plugin-Version: copilot-chat/0.35.0`, `Copilot-Integration-Id: vscode-chat`, `X-GitHub-Api-Version: 2026-06-01`, and `Openai-Intent: conversation-edits`. Each request adds `Authorization` and `X-Initiator: user`; the session-created `X-Interaction-Id` is reused by the intent call and native model request.


## Session token injection

Both native backends inject `Copilot-Session-Token` through request-local `options.headers`. Pi wraps the base `PiProvider`; OMP uses `streamSimple` and delegates the resolved model to OMP's native stream dispatcher. This preserves the host's API-specific serialization, retry, usage, and session handling without modifying process-global fetch.

### FetchPatch fallback

When a native stream bridge is unavailable, the extension may patch `globalThis.fetch` as an OMP/Pi compatibility fallback. The patch is restricted to `POST` requests on the exact Copilot chat paths:

- `/chat/completions`
- `/v1/messages`
- `/responses`

Control endpoints (`/models/session`, `/models/session/intent`) and look-alike paths pass through untouched. Retry leases and FIFO token queues are used only on this fallback path and are cleared at compaction, shutdown, and credential disable. Shutdown and credential disable also discard every cached conversation session, so no token or asynchronous route result survives into the next host session. Tokens are never logged.

## Architecture

Object-oriented, dependency-inverted (smart-approve convention); every concern is a class:

```
CopilotAuto (orchestrator)           — hook wiring, prompt capture, lifecycle
 ├─ RuntimeCompat                    — runtime discriminator (OMP vs Pi), load-phase
 │                                    OAuth marker, catalog + credential adapters
 ├─ ProviderRegistrar                — load-phase github-copilot/auto registration
 │                                    + session_start re-anchor (bearer → probe → endpoint)
 ├─ CapiClient                       — POST /models/session + POST /models/session/intent
 ├─ ConvStateStore                   — per (sessionId × auto) session token + sticky routing
 ├─ IntentRouter                     — endpoint-aware pool selection + reasoning boost
 ├─ OmpNativeProvider (src/omp-native-provider.ts)
 │                                    — OmpProviderConfig with streamSimple + fetchDynamicModels
 ├─ PiNativeProvider  (src/pi-native-provider.ts)
 │                                    — wrapPiProvider: wraps base PiProvider, injects headers
 ├─ FetchPatch (fallback)            — globalThis.fetch patch stamping Copilot-Session-Token
 ├─ PendingTokenQueue                — FIFO per-wire-model token queue, session-tagged
 ├─ RequestLeaseTable                — retry lease for byte-identical chat POSTs
 └─ Logger / RotatingLog             — ~/.omp/logs/copilot-auto.log or ~/.pi/logs/...
```

The shared core bundle (`dist/index.js`) has no static `@oh-my-pi` / `@earendil-works` imports and stays loadable under either runtime. Host-specific entries (`dist/omp.js` and `dist/pi.js`) import only their own AI bridge, install it at the edge, then call the shared core. The shared API otherwise uses structural interfaces (`types.ts`).

## Limitations (honest scope)

- **OMP registration replacement**: OMP replaces a provider's model list when `models` is supplied. The native adapter therefore submits the complete Copilot catalog plus `auto` and current-pool aliases; it must not submit aliases alone.
- **Native transport bridge**: Pi uses its base Provider directly. OMP's public extension form requires a native stream delegate; if the host cannot resolve one, the extension explicitly falls back to the hook/FetchPatch path.
- **Pool visibility scope**: model-picker aliases use the latest successful host/account pool snapshot. Each conversation still revalidates forced aliases against its own session pool before sending a token.
- **Registration is per-host-session**: subagent/task runners that do not load extensions bypass routing and send the selected catalog model directly.
- **Routing is best-effort**: intent failures, probe timeouts or missing credentials leave the host's original request path available; a forced alias fails closed when its target is unavailable.
- **Endpoints are client-internal / undocumented**: `POST /models/session` and `POST /models/session/intent` are observed from Copilot clients — they are not part of a public GitHub API. Their wire format, stability, and availability may change without notice.

## Tests / build

```sh
bun test src        # node:test suites: orchestrator, registrar, runtime compat,
                    # intent router, fetch patch, capi client, conv state, token queue,
                    # OMP native provider, Pi native provider
bun run typecheck   # tsc --noEmit
bun run build       # → dist/index.js + dist/omp.js + dist/pi.js
node scripts/test-pi-load.mjs   # Pi-host simulation: loads dist/index.js with
                                # plain Node, isolated HOME, no OMP package,
                                # and separately exercises dist/pi.js with a
                                # minimal Pi AI bridge stub
```

## License

MIT
