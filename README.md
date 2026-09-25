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
├── vercel.json         ← legacy Vercel config (see Deployment)
├── public/
│   ├── index.html      ← SPA shell + CDN library imports
│   ├── style.css       ← responsive dark theme
│   └── app.js          ← streaming client, session memory, Marked + hljs
└── tests/
    ├── server.test.js      ← static structure / config assertions
    └── integration.test.js ← boots the server against a stub upstream
```

---

## Local Setup

### Prerequisites

- **Node.js** ≥ 18.0.0
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
- **Healthcheck built in.** Docker polls `/api/health`; orchestrators and
  load balancers should point at the same endpoint.
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

`HOST` and `PORT` are set by the image; most platforms inject their own
`PORT`, which the server honours.

### Fly.io

```bash
fly launch --no-deploy            # detects the Dockerfile
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

In `fly.toml`, keep `auto_stop_machines` off (or accept a cold start on the
first message) and set `[http_service] internal_port = 3000`.

### Render

Create a **Web Service** → **Docker** runtime pointed at this repo. Render
reads the `Dockerfile` and the `HEALTHCHECK`; set the health check path to
`/api/health` and add the environment variables above. No build or start
command is needed — the image defines both.

### Railway

`railway up` (or connect the repo). Railway detects the `Dockerfile`
automatically. Add the environment variables in the dashboard.

### Legacy: Vercel

`vercel.json` is kept for the existing deployment, but serverless is a poor
fit for this app: functions have a hard maximum duration, and every response
is a long-lived SSE stream. A container host is recommended instead. Note
that `@vercel/node` **ignores the `Dockerfile`** — the two deployment paths
share no build logic.

---

## Testing & CI

```bash
npm test               # unit + integration
npm run test:unit      # static structure assertions only
npm run test:integration
npm run lint
```

`tests/integration.test.js` boots `server.js` as a real child process against
a stub OpenAI-compatible upstream on localhost, so it exercises the actual
SSE wire format with **no network calls, no API key and no GPU spend**. It
exists because the original suite asserted on the *text* of `server.js` and
therefore passed while the client called an undefined variable and parsed a
message shape the server never sent.

GitHub Actions runs four jobs on every push and pull request: tests on Node
20/22/24, ESLint, a Docker build plus a container smoke test (health, static
route, SSE headers, clean `SIGTERM` exit, non-root, no secrets in the image),
and a dependency/secret audit.

---

## Scaling notes

The server is stateless — conversation history lives in the browser's
`localStorage`, so there is no database and any instance can serve any
request. Two caveats before adding replicas:

- **Rate limiting is per process.** `express-rate-limit` uses its in-memory
  store, so N replicas allow N × 20 requests/minute per IP. Move to a shared
  store (Redis) if you scale out.
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