# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

### Prerequisites
- Go `1.26.0` (`go.mod`)
- Node.js `20.19+` or `22.12+` when building or developing `webui/` (`README.MD`)

### Local development
- Initialize config: `cp config.example.json config.json`
- Run backend directly: `go run ./cmd/ds2api`
- Use the helper launcher:
  - `node start.mjs dev` — Go backend + Vite frontend
  - `node start.mjs prod` — run built backend binary
  - `node start.mjs build` — build backend binary
  - `node start.mjs webui` — build frontend assets
  - `node start.mjs install` — install frontend deps

### Build
- Build backend: `go build -o ./ds2api ./cmd/ds2api`
- Build WebUI: `npm ci --prefix webui && npm run build --prefix webui`
- Alternate WebUI build wrapper: `./scripts/build-webui.sh`

### Lint / format
- Repo lint gate: `./scripts/lint.sh`
- Format changed Go files before finishing work: `gofmt -w <changed-files>`

### Tests
- All unit tests: `./tests/scripts/run-unit-all.sh`
- Go unit tests only: `./tests/scripts/run-unit-go.sh`
- Node unit tests only: `./tests/scripts/run-unit-node.sh`
- All Go tests directly: `go test ./...`
- Single Go package / named test example: `go test -v -run 'TestParseToolCalls|TestRepair' ./internal/toolcall/`
- Single Node test file: `node --test --test-concurrency=1 tests/node/chat-stream.test.js`
- Node syntax gate for split runtime files: `./tests/scripts/check-node-split-syntax.sh`
- Refactor gate: `./tests/scripts/check-refactor-line-gate.sh`
- Manual smoke sign-off gate: `./tests/scripts/check-stage6-manual-smoke.sh`
- End-to-end live suite: `./tests/scripts/run-live.sh`
- End-to-end suite with flags: `go run ./cmd/ds2api-tests --config config.json --admin-key admin --out artifacts/testsuite --timeout 120 --retries 2`

### PR / release gate
Before opening or updating a PR, run the same local gates as `.github/workflows/quality-gates.yml` and `AGENTS.md`:
- `./scripts/lint.sh`
- `./tests/scripts/check-refactor-line-gate.sh`
- `./tests/scripts/run-unit-all.sh`
- `npm run build --prefix webui`

## High-level architecture

### Runtime entrypoints
- `cmd/ds2api/main.go` is the normal server entrypoint. It loads env/config, refreshes logging, auto-builds the WebUI when needed, creates the app, and serves HTTP on `0.0.0.0:$PORT`.
- `app/handler.go` is the shared app wrapper for serverless environments.
- `api/index.go` is the Vercel Go function entrypoint and reuses the same app via `app.NewHandler()`.
- `api/chat-stream.js` is the Vercel Node entrypoint for streaming chat responses and delegates into `internal/js/chat-stream/`.

### Router and shared app state
`internal/server/router.go` is the composition root. `NewApp()` builds and wires together:
- `internal/config.Store` for config loading and runtime settings
- `internal/account.Pool` for managed-account concurrency and queueing
- `internal/auth.Resolver` for API-key / token / account resolution
- `internal/deepseek.Client` for upstream DeepSeek communication and PoW preload
- `internal/chathistory.Store` for server-side chat history persistence
- protocol handlers for OpenAI, Claude, Gemini, Admin, and WebUI

If a change affects request flow, start in `internal/server/router.go` and trace from there.

### Protocol adapters: one core, multiple wire formats
The OpenAI adapter is the execution core:
- `internal/adapter/openai/` owns `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/files`, and `/v1/embeddings`.
- `internal/adapter/claude/` and `internal/adapter/gemini/` adapt their protocol shapes, but they are not separate upstream implementations. They depend on the OpenAI path and the shared translation layer instead of duplicating DeepSeek execution logic.
- `internal/translatorcliproxy/` is the protocol bridge used to translate Claude/Gemini structures to and from the OpenAI-centric core.

When adding behavior that should work across OpenAI, Claude, and Gemini, implement it in the shared/OpenAI execution path first, then verify the protocol adapters still translate correctly.

### Upstream integration and account management
The main non-HTTP runtime pieces are:
- `internal/deepseek/` — upstream request/session/auth/SSE handling
- `pow/` — PoW implementation used by the DeepSeek client
- `internal/account/` — managed account pool, in-flight slot limits, wait queue
- `internal/auth/` — resolves whether a request uses a managed API key or a direct DeepSeek token
- `internal/config/` — config loading, validation, and hot-updatable runtime/admin settings

`config.json` is the primary configuration source in normal development. Environment variables mainly exist for deployment modes like Vercel and Docker.

### Streaming and tool-calling are cross-runtime features
Streaming and tool-calling logic spans both Go and Node code:
- Go side: `internal/stream/`, `internal/sse/`, `internal/toolcall/`, and parts of `internal/adapter/openai/`
- Node side: `internal/js/chat-stream/` and tests in `tests/node/`

This matters because Vercel does not always use the Go path for `/v1/chat/completions` streaming:
- `vercel.json` routes `/v1/chat/completions` to `api/chat-stream.js` by default
- adding `?__go` forces that route back to the Go handler
- `internal/js/chat-stream/index.js` proxies non-stream or non-Vercel cases back to Go, so the Node path is mainly a Vercel streaming bridge

If you change SSE framing, tool-call parsing, incremental deltas, or leak filtering, check both the Go and Node implementations and run both Go and Node tests.

### Admin and WebUI
- `internal/admin/` serves `/admin/*` APIs for login, config import/export, runtime settings, key/account/proxy management, queue status, Vercel sync, dev captures, chat history, and version checks.
- `webui/` is the Vite + React admin source.
- `static/admin/` is the built frontend served at runtime.
- `internal/webui/` serves the built assets and admin SPA fallback.

Do not treat `static/admin/` as source code. Make UI changes in `webui/`, then rebuild.

### Tests and fixtures
- Go tests mostly live next to the packages they cover.
- Node runtime regression tests live in `tests/node/`.
- `tests/raw_stream_samples/` contains captured upstream streaming samples used for replay/regression workflows.
- `cmd/ds2api-tests` is the end-to-end test CLI used by `./tests/scripts/run-live.sh`.

## Repository-specific notes
- `AGENTS.md` is active guidance for automated changes in this repo.
- Do not ignore cleanup errors from `Close`, `Flush`, `Sync`, and similar I/O-style calls. Return or log them explicitly.
- The repo does not commit WebUI build artifacts as source-of-truth; deploy/build systems generate `static/admin`.
