/**
 * ============================================================
 *  Server-Sent Events (SSE) AI Chat Backend
 *  Author: Aaron Lee F. Angeles
 *  ------------------------------------------------------------
 *  - Express serves the static frontend from ./public
 *  - Helmet.js security headers (CSP, X-Frame-Options, etc.)
 *  - CORS restricted to known origins only
 *  - Uses the official OpenAI Node.js SDK via custom baseURL,
 *    streaming tokens as SSE to the browser.
 *  - The API key is read ONLY from .env on the server. It is
 *    never sent to, or accessible from, the browser.
 *  - Disconnect handling: req.on('close') aborts the OpenAI
 *    fetch if the client closes the connection early (saves GPU).
 *  - Rate-limit handling: 429 concurrency errors are caught and
 *    translated into a clean user-friendly SSE error event.
 * ============================================================
 */

/* ---------------------------------------------------------- *
 *  Dependencies
 * ---------------------------------------------------------- */
const path = require('node:path');
const http = require('node:http');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config(); // Load .env into process.env (server only)
const { OpenAI } = require('openai');

/* ---------------------------------------------------------- *
 *  Configuration
 * ---------------------------------------------------------- */
const PORT = Number(process.env.PORT) || 3000;
// Bind all interfaces by default: inside a container, 127.0.0.1 is only
// reachable from within the container itself and the platform health check
// would never connect.
const HOST = process.env.HOST || '0.0.0.0';
const APP_URL = process.env.APP_URL || '';

// How long to let in-flight SSE streams drain on SIGTERM before forcing exit.
// Container platforms send SIGKILL after their own grace period (Fly ~5s
// default, Render 30s), so finish first and exit on our own terms.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

// Interval for SSE keep-alive comments. Proxies in front of a container
// (Fly, Render, nginx) close idle connections; a comment line keeps the
// socket warm while the upstream model is still thinking.
const SSE_HEARTBEAT_MS = 15_000;

// Optional shared secret for API authentication.
// If set, the browser must send it as the `x-shared-secret` header
// on every /api/chat call, otherwise the request is rejected with 401.
// This stops anyone who finds the app URL from draining your Dahl credits.
const SHARED_SECRET = process.env.SHARED_SECRET || '';

// Only these origins are allowed to access the API.
// APP_URL covers the deployed Vercel/Render production URL.
const ALLOWED_ORIGINS = [
  APP_URL,
  'http://localhost:3000',
  'http://localhost:3',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3',
].filter(Boolean);

// Fail fast if the Dahl Inference API key is missing.
if (!process.env.OPENAI_API_KEY) {
  console.error(
    '[error] OPENAI_API_KEY is not set. ' +
      'Copy .env.example to .env and add your key before starting.'
  );
  process.exit(1);
}

if (process.env.OPENAI_API_KEY === 'sk-your-secret-api-key-here') {
  console.error(
    '[error] You are still using the placeholder OPENAI_API_KEY. ' +
      'Put your real Dahl Inference key in .env.'
  );
  process.exit(1);
}

/* ---------------------------------------------------------- *
 *  OpenAI client — Dahl Inference custom provider
 * ---------------------------------------------------------- */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://inference.dahl.global/v1',
});

const MODEL = process.env.OPENAI_MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';

/* ---------------------------------------------------------- *
 *  Express app
 * ---------------------------------------------------------- */
const app = express();
app.set('trust proxy', 1); // Required so express-rate-limit reads X-Forwarded-For correctly on Vercel
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting — protect /api/chat from abuse ─────────────────────────
// Limits each IP to 20 chat requests per 60 seconds.
// This prevents a malicious visitor from draining your Dahl API credits
// by hammering the endpoint. Returns HTTP 429 with a friendly message.
//
// NOTE: this uses the default in-memory store, so the counter is per
// process. Running more than one container/replica multiplies the real
// limit by the replica count. Move to a shared store (Redis) if you scale
// horizontally — see README "Scaling notes".
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 20,                    // 20 requests per window per IP
  standardHeaders: true,      // include RateLimit-* headers
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a moment before sending another message.',
  },
});

// ── Optional shared-secret authentication middleware ─────────────────────
// If SHARED_SECRET is set, every /api/chat request must include it in the
// `x-shared-secret` header. Returns 401 otherwise.
// This stops strangers from using the app (and your API credits).
function requireApiKey(req, res, next) {
  if (!SHARED_SECRET) return next(); // auth disabled if no secret configured
  const provided = req.headers['x-shared-secret'];
  if (provided === SHARED_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized: missing or invalid x-shared-secret header.' });
}

// ── Helmet security headers ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        'https://cdn.jsdelivr.net',
        'https://cdnjs.cloudflare.com',
        "'unsafe-inline'", // highlight.js and marked.js need this
      ],
      styleSrc: [
        "'self'",
        'https://cdn.jsdelivr.net',
        'https://cdnjs.cloudflare.com',
        "'unsafe-inline'",
      ],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:'],
      // Allow SSE POST calls to the same origin
      connectSrc: [
        "'self'",
        APP_URL,
        'http://localhost:3000',
      ],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS — restrict to known origins ────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  next();
});

// Serve static frontend assets from ./public.
app.use(express.static(path.join(__dirname, 'public')));

// Request logger.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* ---------------------------------------------------------- *
 *  POST /api/chat — SSE streaming endpoint
 * ---------------------------------------------------------- *
 *  SSE headers (in order):
 *    Content-Type      → text/event-stream; charset=utf-8
 *    Cache-Control     → no-cache, no-transform  (defeats CDN caching)
 *    Connection        → keep-alive
 *    X-Accel-Buffering → no                    (defeats Vercel proxy buffer)
 *    Content-Encoding  → identity              (prevents gzip on stream)
 * ---------------------------------------------------------- */
app.post('/api/chat', chatLimiter, requireApiKey, async (req, res) => {
  // Set all SSE headers before any flushing.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');

  // Flush headers NOW — before validation and before the upstream call.
  // Previously this happened only after the model stream had opened, so the
  // browser waited out time-to-first-token plus up to ~7.5s of 429 backoff
  // with nothing on the wire, which proxies treat as an idle connection.
  res.flushHeaders();

  // Keep-alive comments. `: ping` lines are ignored by SSE parsers but stop
  // proxies (Fly, Render, nginx) from dropping a stream that is still waiting
  // on the model.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // Single exit path: stops the heartbeat and closes the response exactly
  // once, no matter which branch we leave through.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    try {
      if (!res.writableEnded) res.end();
    } catch (_) { /* already closed */ }
  };

  // Helper to emit a named SSE event.
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { messages = [], temperature = 0.7 } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    send('error', { message: 'Invalid request: messages array is required.' });
    finish();
    return;
  }

  const payloadMessages = [
    {
      role: 'system',
      content:
        'You are a helpful, concise, and knowledgeable AI assistant. ' +
        'Answer the user clearly, preferring well-structured responses ' +
        'with Markdown and code blocks where appropriate.',
    },
    ...messages,
  ];

  // ── Disconnect handler ──────────────────────────────────────────────────
  // Dahl's Gonka network rejects the AbortController `signal` parameter,
  // so we cannot cancel in-flight GPU work. We detect client disconnects
  // via req.on('close') and close the SSE response early.
  req.on('close', () => {
    if (!finished) {
      console.log('[info] Client disconnected mid-stream');
      finish();
    }
  });

  // Retry logic for 429 (concurrency capacity) errors.
  // Tries up to MAX_RETRIES times with exponential backoff.
  const MAX_RETRIES = 2;
  let lastErr = null;
  let stream = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      stream = await openai.chat.completions.create({
        model: MODEL,
        messages: payloadMessages,
        temperature,
        stream: true,
        // NOTE: `signal` is deliberately omitted — Dahl/Gonka rejects it.
      });
      lastErr = null;
      break; // stream created successfully
    } catch (err) {
      lastErr = err;
      const status = err.status;

      if (status === 429 && attempt < MAX_RETRIES) {
        // Model at capacity — wait and retry
        const waitMs = (attempt + 1) * 2500;
        console.log(`[warn] Dahl at capacity (attempt ${attempt + 1}/${MAX_RETRIES + 1}), waiting ${waitMs}ms…`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Non-retryable error (or all retries exhausted)
      let userMessage;
      if (status === 429) {
        userMessage = 'The model is at capacity. Please try again in a moment.';
      } else if (status === 401 || status === 403) {
        userMessage = 'Authentication error. Check your API key configuration.';
      } else if (
        err.message?.includes('timeout') ||
        err.message?.includes('ECONNREFUSED')
      ) {
        userMessage = 'Could not reach the AI service. Check your connection.';
      } else {
        userMessage = `AI service error: ${err.message}`;
      }

      console.error(`[error] Stream failed (attempt ${attempt + 1}, ${status || 'unknown'}): ${err.message}`);
      send('error', { message: userMessage });
      finish();
      return;
    }
  }

  // If all retries failed, lastErr is set — handle it above, so we never reach here.
  if (lastErr) {
    send('error', { message: 'The model is unavailable. Please try again.' });
    finish();
    return;
  }

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const token = typeof delta?.content === 'string' ? delta.content : '';
      if (token) {
        send('delta', { token });
      }
    }
    send('done', {});
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[error] Stream interrupted:', err.message);
      send('error', { message: `Stream interrupted: ${err.message}` });
    }
  } finally {
    finish();
  }
});

// Health check — used by the UI to confirm the server is live.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

// 404 for unknown API routes (must be registered AFTER specific routes).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ---------------------------------------------------------- *
 *  Start server
 * ---------------------------------------------------------- */
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('  Aaron AI Chat — Dahl Inference');
  console.log(`  ➜  Local:   http://localhost:${PORT}  (bound to ${HOST}:${PORT})`);
  console.log(`  ➜  Model:   ${MODEL}`);
  console.log('  ➜  Provider:', process.env.OPENAI_BASE_URL || 'https://inference.dahl.global/v1');
  console.log('  ➜  Helmet security headers:  enabled');
  console.log('  ➜  CORS origins:', ALLOWED_ORIGINS.join(', ') || 'none (API-only usage)');
  console.log('  ➜  429 (rate-limit) handling: enabled');
  console.log('  ➜  Disconnect abort (req.on close): enabled');
  console.log('============================================================');
});

let shuttingDown = false;

const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[info] ${signal || 'signal'} received — shutting down gracefully...`);

  // Stop accepting new connections, let in-flight SSE streams drain.
  server.close(() => {
    console.log('[info] Server closed.');
    process.exit(0);
  });

  // An open SSE stream would otherwise hold server.close() forever and the
  // platform would SIGKILL us mid-request. Exit on our own terms first.
  const force = setTimeout(() => {
    console.warn(`[warn] Forcing exit after ${SHUTDOWN_TIMEOUT_MS}ms with connections still open.`);
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));