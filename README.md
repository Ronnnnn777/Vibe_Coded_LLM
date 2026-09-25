# Aaron AI Chat

> A lightweight, streaming AI chat application built with Node.js/Express on the backend and pure Vanilla JS/HTML/CSS on the frontend. Authored by **Aaron Lee F. Angeles**.

---

## Features

- **Real-time SSE streaming** — tokens appear as they are generated, no waiting for the full response
- **Session memory** — conversation history persists across page refreshes via `localStorage`
- **Markdown rendering** — AI responses display headers, lists, tables, and blockquotes via Marked.js
- **Syntax highlighting** — code blocks are highlighted with highlight.js (Atom One Dark theme)
- **Responsive design** — sidebar collapses to a slide-in drawer on mobile (≤ 860 px)
- **API key security** — the key is loaded by `dotenv` on the server only and is never exposed to the browser
- **Container-ready** — multi-stage Docker image, non-root, healthcheck, graceful `SIGTERM` drain

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | the chat UI (static files from `public/`) |
| `POST /api/chat` | SSE token stream; `503` if no API key is configured |
| `GET /api/health` | **liveness** — always `200` while the process is up, reports `{ ok, model, configured }` |
| `GET /api/ready` | **readiness** — `200` only when an API key is configured, otherwise `503` |

### Health vs readiness

The server **starts even without `OPENAI_API_KEY`**. A container that exits
immediately takes its logs with it, and a platform health check that never
answers tells you nothing; instead the process comes up, says
`"configured": false`, and refuses chat requests with a clear `503`.

- Point your platform's **deploy gate at `/api/ready`** so a release missing
  credentials fails and rolls back.
- Point **container/liveness probes at `/api/health`**.
- Prefer the old fail-fast behaviour? Set `REQUIRE_API_KEY=true` and the
  process exits 1 on boot instead.

`/api/chat` security is unchanged by this: rate limiting and the optional
shared secret still apply, and an unconfigured server serves no tokens.

---

## Project Structure

```
.
├── .env.example        ← copy to .env and fill in your API key
├── .dockerignore       ← keeps .env and tests out of the build context
├── .gitignore          ← .env and node_modules are ignored
├── Dockerfile          ← multi-stage production image (non-root, healthcheck)
├── docker-compose.yml  ← local parity with the container hosts
├── eslint.config.js    ← ESLint 9 flat config
├── package.json
├── server.js           ← Express + OpenAI SDK + SSE streaming backend
├── vercel.json         ← Vercel config, best-effort target (see Deployment)
├── public/
│   ├── index.html      ← SPA shell + CDN library imports
│   ├── style.css       ← responsive dark theme
│   └── app.js          ← streaming client, session memory, Marked + hljs
└── tests/
    ├── config.test.js      ← env template, ignore files, toolchain versions
    └── integration.test.js ← runtime tests against the real Express app
```

---

## Local Setup

### Prerequisites

- **Node.js** ≥ 20.9.0 (enforced; see *Command reference*)
- A valid API key from your Dahl Inference provider

### Steps

```bash
# 1. Clone the repository (or copy the files into a new folder)
git clone https://github.com/YOUR_HANDLE/aaron-ai-chat.git
cd aaron-ai-chat

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Open .env and replace the placeholder values with your real credentials:
#   OPENAI_API_KEY=sk-your-actual-key
#   OPENAI_BASE_URL=https://inference.dahl.global/v1
#   OPENAI_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
#   PORT=3000

# 4. Start the development server
npm start

# → Open http://localhost:3000 in your browser
```

For live reload on file changes during development:

```bash
npm run dev
```

### Command reference

| Command | What it does |
|---|---|
| `npm start` | production-style run (`node server.js`) |
| `npm run dev` | watch mode |
| `npm test` | unit + runtime tests (`node --test`, no network) |
| `npm run test:unit` | repo/config assertions only |
| `npm run test:integration` | runtime tests only |
| `npm run lint` | ESLint 9 flat config; fails on errors |
| `npm run lint:fix` | autofix |
| `npm run check` | `lint && test` — the same gate CI runs |
| `npm run docker:build` / `docker:run` | build and run the production image |

`check` does **not** run automatically. To make it a real pre-commit gate:

```bash
printf '#!/bin/sh\nnpm run check\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

(Or wire it with Husky/lefthook if you prefer something committed to the repo.)

**Lint warnings are ratcheted.** `npm run lint` passes `--max-warnings=71`,
today's exact count — so any *new* warning fails the build, while the
existing backlog (mostly `no-var` in the pre-existing frontend) does not
block. Lower the number as you clean up; never raise it.

**Node version:** `>=20.9.0`, enforced by `engine-strict=true` in `.npmrc`.
Node 18 is EOL and ESLint 9 needs ≥18.18, so the floor is 20.9.0 — and CI
pins that exact version as its lowest matrix entry (`20.9.0`, `22`, `24`) so
the declared bound is the bound actually tested.

There is deliberately **no upper bound**: with `engine-strict=true`, a cap
like `<25` would make `npm ci` hard-fail on Node 25/26, which is what current
releases are today. Drift is caught by tests instead —
`tests/config.test.js` fails if `engines.node`, the CI matrix and the
Dockerfile base image ever disagree (and, if you do add an upper bound, that
every matrix entry respects it). A separate **non-blocking** weekly workflow
(`.github/workflows/node-current.yml`) runs the suite on Node `current`, so a
breaking release shows up as a canary failure rather than a surprise on the
day you bump the floor.

---

## Docker

The image is the deployment artifact for every target below. There is no
frontend build step — the container just serves `public/` and runs Express.

```bash
# Build and run directly
docker build -t aaron-ai-chat .
docker run --rm --init -p 3000:3000 --env-file .env aaron-ai-chat

# …or with Compose (rebuilds on change)
docker compose up --build
```

Details worth knowing:

- **Non-root.** The runtime stage drops to the built-in `node` user.
- **Healthcheck built in.** Docker polls `/api/health` (liveness) — chosen so
  a running-but-unconfigured container reports healthy instead of restart-
  looping before you can read its logs. Point the **platform's** deploy gate
  at `/api/ready` so a release missing credentials fails. CI asserts both
  halves of this contract.
- **`HOST=0.0.0.0` by default.** Binding `127.0.0.1` inside a container makes
  the app unreachable from outside it — the most common "works locally,
  dead in prod" failure for this kind of app.
- **Graceful stop.** `SIGTERM` drains in-flight SSE streams, then the process
  exits on its own after `SHUTDOWN_TIMEOUT_MS` (default 10s) rather than
  waiting to be `SIGKILL`ed mid-response.
- **Dev tooling is excluded.** `.dockerignore` keeps `.env`, `tests/` and
  `.git/` out of the build context; CI asserts none of them reach the image.

---

## Deployment

Required environment variables on every platform:

| Key | Value |
|---|---|
| `OPENAI_API_KEY` | your Dahl Inference key (**secret**) |
| `OPENAI_BASE_URL` | `https://inference.dahl.global/v1` |
| `OPENAI_MODEL` | `deepseek-ai/DeepSeek-V4-Flash-0731` |
| `APP_URL` | your public URL, e.g. `https://chat.example.com` (locks down CORS/CSP) |
| `SHARED_SECRET` | optional — requires an `x-shared-secret` header on `/api/chat` |
| `REQUIRE_API_KEY` | optional — `true` makes the process exit 1 instead of booting degraded |

`HOST` and `PORT` are set by the image; most platforms inject their own
`PORT`, which the server honours. **Set the platform's health check to
`/api/ready`** so a deploy without credentials fails instead of going live
and returning 503s to users.

### Fly.io

```bash
fly launch --no-deploy            # detects the Dockerfile
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

In `fly.toml`: set `[http_service] internal_port = 3000`, point the check at
`/api/ready`, and keep `auto_stop_machines` off (or accept a cold start on
the first message — a suspended machine cannot stream).

```toml
[[http_service.checks]]
  method = "GET"
  path = "/api/ready"
  interval = "30s"
  timeout = "5s"
```

### Render

Create a **Web Service** → **Docker** runtime pointed at this repo. Render
reads the `Dockerfile`; set **Health Check Path** to `/api/ready` and add the
environment variables above. No build or start command is needed — the image
defines both. Render waits ~30s after `SIGTERM`, which is comfortably longer
than the server's own 10s drain.

### Railway

`railway up` (or connect the repo). Railway detects the `Dockerfile`
automatically. Add the environment variables in the dashboard and set the
health check path to `/api/ready`.

### Vercel (best-effort)

`vercel.json` is kept working and CI validates its routing and SSE headers,
but serverless is a poor fit for this app and it is **not** the recommended
target:

- Functions have a **hard maximum duration**; a long answer can be cut off
  mid-stream.
- Responses pass through a CDN that wants to buffer. `vercel.json` sets
  `X-Accel-Buffering: no` and `Cache-Control: no-store`, and the server sends
  `: ping` keep-alives, but streaming remains best-effort.
- Rate limiting is per-instance (see *Scaling notes*), so concurrent lambdas
  multiply the effective limit.
- `@vercel/node` **ignores the `Dockerfile`** — the two paths share no build
  logic, so a green `docker build` says nothing about a Vercel deploy.

```bash
npm i -g vercel
vercel link
vercel env add OPENAI_API_KEY      # then OPENAI_BASE_URL, OPENAI_MODEL, APP_URL
vercel --prod
```

`@vercel/node` requires the entrypoint in `vercel.json` (`server.js`) to
export a **callable** request handler — an object export fails at runtime
with *"the default export is not a function"*, and `npm start` would not
reveal it because that path goes through `require.main === module` instead.
So `module.exports` is the Express app itself, with the named helpers
(`createApp`, `start`, …) attached as properties. A test asserts the export
stays callable and that `vercel.json` points at that same file.

Use a container host if streaming reliability matters.

---

## Testing & CI

```bash
npm test               # unit + integration
npm run test:unit      # static structure assertions only
npm run test:integration
npm run lint
```

`server.js` exports the Express app and only calls `listen()` when run
directly, so `tests/integration.test.js` drives the **real app in-process**
on an ephemeral port — health, readiness, static files, the SSE byte stream,
the shared-secret gate, and the browser parser in `public/app.js` replayed
against a live response. The upstream LLM gateway is stubbed on localhost:
**no network calls, no API key, no GPU spend.** A few cases that need a real
process (boot without credentials, `REQUIRE_API_KEY=true` exiting 1, clean
`SIGTERM`) spawn `node server.js`.

This replaced a suite that asserted on the *text* of `server.js`; it passed
while the client called an undefined variable and parsed a message shape the
server never sent. `tests/config.test.js` keeps only the checks that have no
runtime equivalent (env template, ignore files, deploy config, toolchain
version agreement).

GitHub Actions runs five jobs on every push and pull request:

| Job | What it guards |
|---|---|
| Test (Node 20/22/24) | `npm ci` + the full suite on every supported runtime |
| Lint | ESLint 9, fails on errors (no `\|\| true` masking) |
| Production install | `npm ci --omit=dev`, then proves the app still loads |
| Docker | image build, boot **without** credentials, health/ready/chat states, SSE through the container, non-root, no secrets in the image, exit 0 on `SIGTERM` |
| Security | `npm audit`, `.env` ignored by git *and* Docker, no key in `public/`, no hardcoded credentials |

---

## Scaling notes

The server is stateless — conversation history lives in the browser's
`localStorage`, so there is no database and any instance can serve any
request. Two caveats before adding replicas:

- **Rate limiting is per process.** `express-rate-limit` uses its default
  `MemoryStore`, so N replicas allow N × 20 requests/minute per IP — and on
  serverless (Vercel) each cold instance starts with an empty counter, which
  makes the limit close to meaningless. Move to a shared store (Redis) if you
  scale out or deploy to lambdas.
- **Sticky sessions are not required**, but a proxy that buffers responses
  will break streaming. The server sets `X-Accel-Buffering: no` and sends
  `: ping` keep-alives every 15s; make sure your platform honours them.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| AI SDK | OpenAI Node.js SDK (v4) |
| Gateway | Dahl Inference (`https://inference.dahl.global/v1`) |
| Model | `deepseek-ai/DeepSeek-V4-Flash-0731` |
| Streaming | Server-Sent Events (SSE) via `text/event-stream` |
| Frontend | Vanilla JavaScript (ES2022), HTML5, CSS3 |
| Markdown | Marked.js (CDN) |
| Syntax highlighting | Highlight.js v11.9 (CDN, Atom One Dark) |
| Sanitisation | DOMPurify (CDN) |
| Container | Docker (multi-stage, `node:22-alpine`, non-root) |
| Tests | Node built-in test runner (`node --test`) |
| Lint | ESLint 9 (flat config) |
| CI | GitHub Actions — test matrix, lint, Docker smoke test, audit |
| Database | none — stateless server, history in `localStorage` |

---

## Authorship

Designed, architected, and developed by **Aaron Lee F. Angeles**.

Built without heavy frontend frameworks to ensure fast rendering and a clean, dependency-light codebase suitable for professional portfolio demonstration.