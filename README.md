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

---

## Project Structure

```
.
├── .env.example       ← copy to .env and fill in your API key
├── .gitignore         ← .env and node_modules are ignored
├── package.json
├── server.js          ← Express + OpenAI SDK + SSE streaming backend
├── vercel.json        ← Vercel deployment configuration
└── public/
    ├── index.html     ← SPA shell + CDN library imports
    ├── style.css      ← responsive dark theme
    └── app.js         ← streaming client, session memory, Marked + hljs
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

## Beta Deployment (Render / Railway)

Both platforms offer a free tier and support Node.js apps with environment variables.

### Option A — Render (recommended for SSE)

1. Create a new **Web Service** on Render.
2. Connect your GitHub repository.
3. Configure the build:

   | Setting | Value |
   |---|---|
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |

4. Add environment variables in the Render dashboard:

   | Key | Value |
   |---|---|
   | `EXPLABS_API_KEY` | `sk-your-experiential-key` |
   | `EXPLABS_BASE_URL` | `https://api.experientiallabs.ai/v1` |
   | `EXPLABS_MODEL` | `claude-fable-5.1` |

5. Deploy. Your app will be live at `https://your-app.onrender.com`.

> **SSE note for Render:** Add a `Cache-Control: no-cache` response header in your Render settings to prevent the proxy from buffering SSE responses. The `vercel.json` already handles this for Vercel deployments.

### Option B — Railway

1. Create a new Railway project and connect your GitHub repo.
2. Add the same environment variables from the table above via the Railway dashboard.
3. Railway auto-detects the `package.json` start script — deploy.

---

## Vercel Deployment

Vercel requires a custom `vercel.json` (included in this project) to route API calls to the Express server and to disable response buffering for SSE.

```bash
# 1. Install the Vercel CLI globally
npm i -g vercel

# 2. Login
vercel login

# 3. Link your project
vercel link

# 4. Add environment variables (do NOT commit .env)
vercel env add EXPLABS_API_KEY
vercel env add EXPLABS_BASE_URL
vercel env add EXPLABS_MODEL

# 5. Deploy
vercel --prod
```

Your production URL will be returned after deployment completes.

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

---

## Authorship

Designed, architected, and developed by **Aaron Lee F. Angeles**.

Built without heavy frontend frameworks to ensure fast rendering and a clean, dependency-light codebase suitable for professional portfolio demonstration.