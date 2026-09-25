/**
 * ============================================================
 *  Unit Tests — Aaron AI Chat Server
 *  Author: Aaron Lee F. Angeles
 *  ------------------------------------------------------------
 *  Uses Node.js built-in test runner (node --test).
 *  These tests do NOT make real API calls — they verify the
 *  Express app's routing, middleware, and error-handling paths.
 * ============================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Load the server source directly so we can inspect its structure
// without starting a real HTTP listener.
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify a string (or array of strings) appears in the source file.
 * Used to confirm critical code paths are present before the app starts.
 */
function srcContains(needle) {
  if (Array.isArray(needle)) {
    return needle.every((n) => serverSrc.includes(n));
  }
  return serverSrc.includes(needle);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('server.js — Static structure', () => {
  it('Express is imported', () => {
    assert.ok(srcContains("require('express')"), 'express require missing');
  });

  it('dotenv is loaded (server-only, never sent to browser)', () => {
    assert.ok(srcContains("require('dotenv').config()"), 'dotenv config missing');
    // Confirms the key is NOT referenced in any public/ file.
    const publicApp = path.resolve(__dirname, '..', 'public', 'app.js');
    const appSrc = fs.readFileSync(publicApp, 'utf8');
    assert.ok(
      !/OPENAI_API_KEY|process\.env\.OPENAI/.test(appSrc),
      'API key leaked into app.js'
    );
  });

  it('OpenAI SDK is imported with custom baseURL', () => {
    assert.ok(srcContains("require('openai')"), 'openai require missing');
    assert.ok(srcContains('baseURL'), 'baseURL config missing from OpenAI client');
    assert.ok(
      srcContains('https://inference.dahl.global/v1'),
      'Dahl Inference base URL missing from server.js'
    );
  });

  it('Model is configurable via OPENAI_MODEL env var', () => {
    assert.ok(srcContains('OPENAI_MODEL'), 'OPENAI_MODEL env var not referenced');
    assert.ok(
      srcContains('deepseek-ai/DeepSeek-V4-Flash-0731'),
      'DeepSeek-V4-Flash-0731 default model missing'
    );
  });

  it('API key placeholder guard exits early if key is missing/placeholder', () => {
    assert.ok(srcContains('process.env.OPENAI_API_KEY'), 'OPENAI_API_KEY env check missing');
    assert.ok(srcContains('process.exit(1)'), 'fail-fast exit(1) missing');
  });

  it('SSE headers are set on /api/chat', () => {
    assert.ok(srcContains("'Content-Type', 'text/event-stream"), 'SSE Content-Type missing');
    assert.ok(srcContains("'X-Accel-Buffering', 'no'"), 'X-Accel-Buffering header missing');
    assert.ok(srcContains("'Cache-Control', 'no-cache"), 'Cache-Control missing');
  });

  it('POST /api/chat route is defined', () => {
    assert.ok(srcContains("app.post('/api/chat'"), '/api/chat POST handler missing');
  });

  it('GET /api/health route is defined', () => {
    assert.ok(srcContains("app.get('/api/health'"), '/api/health GET handler missing');
  });

  it('System prompt is injected so the model has session context', () => {
    assert.ok(
      srcContains('role: \'system\''),
      'system role missing from message payload'
    );
    assert.ok(
      srcContains('...messages'),
      'spread of client history onto payload missing'
    );
  });

  it('Static files are served from ./public', () => {
    assert.ok(srcContains("express.static(path.join(__dirname, 'public'))"),
      'static middleware missing');
  });

  it('Graceful shutdown handlers are registered (SIGINT + SIGTERM)', () => {
    assert.ok(srcContains("process.on('SIGINT'"), 'SIGINT handler missing');
    assert.ok(srcContains("process.on('SIGTERM'"), 'SIGTERM handler missing');
    assert.ok(srcContains('server.close'), 'server.close() call missing');
  });
});

describe('public/app.js — Security & streaming structure', () => {
  const APP_PATH = path.resolve(__dirname, '..', 'public', 'app.js');
  const appSrc = fs.readFileSync(APP_PATH, 'utf8');

  it('API key is NEVER referenced in browser-side code', () => {
    assert.ok(
      !/OPENAI_API_KEY|process\.env\.OPENAI/.test(appSrc),
      'SECURITY VIOLATION: API key referenced in app.js'
    );
  });

  it('fetch() with ReadableStream is used for SSE (not EventSource)', () => {
    assert.ok(
      appSrc.includes('fetch('),
      'fetch() missing from app.js'
    );
    assert.ok(
      appSrc.includes('response.body.getReader'),
      'ReadableStream reader (getReader) missing — required for POST-based SSE'
    );
    assert.ok(
      !appSrc.includes('new EventSource'),
      'EventSource used incorrectly — cannot POST, do not use for streaming chat'
    );
  });

  it('Conversation history is persisted to localStorage', () => {
    assert.ok(
      appSrc.includes('localStorage.setItem'),
      'localStorage.setItem missing — session memory not persisted'
    );
    assert.ok(
      appSrc.includes('localStorage.getItem'),
      'localStorage.getItem missing — session cannot be restored'
    );
  });

  it('Marked.js is guarded against CDN failure (plain-text fallback)', () => {
    assert.ok(
      appSrc.includes('markedAvailable'),
      'markedAvailable guard missing — no fallback if CDN is down'
    );
    assert.ok(
      appSrc.includes('container.textContent = markdown'),
      'Plain-text fallback for Marked.js missing'
    );
  });

  it('highlight.js is guarded against CDN failure', () => {
    assert.ok(
      appSrc.includes('hljsAvailable'),
      'hljsAvailable guard missing — no fallback if CDN is down'
    );
    assert.ok(
      appSrc.includes('block.dataset.highlighted'),
      'Double-highlight guard missing — re-renders may corrupt display'
    );
  });

  it('AbortController stops mid-stream when user sends a new message', () => {
    assert.ok(
      appSrc.includes('AbortController'),
      'AbortController missing — streaming cannot be cancelled cleanly'
    );
    assert.ok(
      appSrc.includes('streamAbortController.signal'),
      'Abort signal not passed to fetch — request cannot be aborted'
    );
  });
});

describe('.env.example — Default configuration', () => {
  const ENV_PATH = path.resolve(__dirname, '..', '.env.example');
  const envSrc = fs.readFileSync(ENV_PATH, 'utf8');

  it('Dahl Inference base URL is the default', () => {
    assert.ok(
      envSrc.includes('https://inference.dahl.global/v1'),
      'Dahl base URL missing from .env.example'
    );
  });

  it('DeepSeek-V4-Flash-0731 is the default model', () => {
    assert.ok(
      envSrc.includes('deepseek-ai/DeepSeek-V4-Flash-0731'),
      'DeepSeek-V4-Flash-0731 model missing from .env.example'
    );
  });

  it('OPENAI_API_KEY is the only required user-supplied value', () => {
    const apiKeyLine = envSrc
      .split('\n')
      .find((l) => l.startsWith('OPENAI_API_KEY='));
    assert.ok(apiKeyLine, 'OPENAI_API_KEY line missing');
    assert.ok(
      apiKeyLine.includes('sk-your-secret-api-key-here'),
      'Placeholder key comment missing from OPENAI_API_KEY'
    );
  });
});

describe('vercel.json — Deployment configuration', () => {
  const VERCEL_PATH = path.resolve(__dirname, '..', 'vercel.json');
  const vercelConfig = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));

  it('Is valid JSON', () => {
    assert.ok(vercelConfig, 'vercel.json failed to parse');
  });

  it('Builds use @vercel/node', () => {
    assert.ok(
      vercelConfig.builds?.some((b) => b.use === '@vercel/node'),
      '@vercel/node builder missing'
    );
  });

  it('API routes target server.js (not a separate Lambda)', () => {
    const apiRoute = vercelConfig.routes?.find((r) => r.src === '/api/(.*)');
    assert.ok(apiRoute, '/api route missing from vercel.json');
    assert.ok(
      apiRoute.dest === '/server.js',
      `API route dest is "${apiRoute.dest}" but should be "/server.js"`
    );
  });

  it('SSE X-Accel-Buffering: no header is set on API routes', () => {
    const apiRoute = vercelConfig.routes?.find((r) => r.src === '/api/(.*)');
    assert.ok(
      apiRoute?.headers?.['X-Accel-Buffering'] === 'no',
      'X-Accel-Buffering: no missing from API route headers'
    );
  });

  it('Cache-Control: no-store is set on API routes to prevent CDN buffering', () => {
    const apiRoute = vercelConfig.routes?.find((r) => r.src === '/api/(.*)');
    const cc = apiRoute?.headers?.['Cache-Control'] || '';
    assert.ok(
      cc.includes('no-store'),
      `Cache-Control should include no-store, got: "${cc}"`
    );
  });

  it('Static assets route through Express (server.js) so /public/ is served correctly', () => {
    const staticRoute = vercelConfig.routes?.find((r) => r.src === '/(.*)');
    assert.ok(staticRoute, 'static catch-all route missing');
    assert.ok(
      staticRoute.dest === '/server.js',
      `Static route dest is "${staticRoute.dest}" but should be "/server.js"`
    );
  });
});

describe('.gitignore — Security', () => {
  const GITIGNORE_PATH = path.resolve(__dirname, '..', '.gitignore');
  const gitignore = fs.readFileSync(GITIGNORE_PATH, 'utf8');

  it('.env is listed (API key must never be committed)', () => {
    assert.ok(
      gitignore.split('\n').some((l) => l.trim() === '.env'),
      '.env is not in .gitignore — SECURITY RISK'
    );
  });

  it('node_modules/ is listed', () => {
    assert.ok(
      gitignore.split('\n').some((l) => l.trim() === 'node_modules/'),
      'node_modules/ not in .gitignore'
    );
  });

  it('*.log is listed (prevent accidental secret log commits)', () => {
    assert.ok(
      gitignore.split('\n').some((l) => l.trim() === '*.log'),
      '*.log not in .gitignore'
    );
  });
});

describe('package.json — Scripts and metadata', () => {
  const PKG_PATH = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

  it('Has a "start" script', () => {
    assert.ok(pkg.scripts?.start, 'start script missing');
  });

  it('Has a "test" script', () => {
    assert.ok(pkg.scripts?.test, 'test script missing');
  });

  it('Has a "lint" script', () => {
    assert.ok(pkg.scripts?.lint, 'lint script missing');
  });

  it('Has a "pre-commit" script that runs lint and test', () => {
    assert.ok(
      pkg.scripts?.['pre-commit']?.includes('lint') &&
      pkg.scripts?.['pre-commit']?.includes('test'),
      'pre-commit script should chain lint && test'
    );
  });

  it('engines field specifies Node >= 18', () => {
    assert.ok(
      pkg.engines?.node && pkg.engines.node.includes('>=18'),
      'engines.node should require >=18'
    );
  });

  it('No devDependencies left undefined (clean)', () => {
    // devDependencies key exists but is empty — intentional (tests use built-in Node runner)
    assert.ok('devDependencies' in pkg, 'devDependencies field missing');
  });

  it('package-lock.json should be committed (not ignored)', () => {
    // Verify package-lock.json would be tracked (not ignored by any lockfile pattern)
    const GITIGNORE_PATH = path.resolve(__dirname, '..', '.gitignore');
    const gitignoreContent = fs.readFileSync(GITIGNORE_PATH, 'utf8');
    const ignored = gitignoreContent.split('\n') || [];
    const lockIgnored = ignored.some((l) => l.trim().startsWith('package-lock.json'));
    assert.ok(!lockIgnored, 'package-lock.json should NOT be in .gitignore — commit it');
  });
});