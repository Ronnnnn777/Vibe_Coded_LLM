/**
 * ============================================================
 *  Integration tests — Aaron AI Chat
 *  ------------------------------------------------------------
 *  tests/server.test.js asserts on the *text* of server.js, which
 *  cannot catch a broken runtime contract. (It passed while the
 *  frontend called an undefined `streamAbortControllerController`
 *  and parsed a wire format the server never emitted.)
 *
 *  These tests boot the real server as a child process, point it at
 *  a stub OpenAI-compatible upstream on localhost, and assert the
 *  bytes that actually reach the browser. No network, no API key,
 *  no GPU — safe to run in CI and inside a Docker smoke test.
 * ============================================================
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** Ask the OS for a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Minimal OpenAI-compatible upstream. Streams two content deltas and
 * [DONE], exactly like the real provider, and records what it was sent.
 */
function startStubUpstream(received) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, body: safeJson(body), auth: req.headers.authorization });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const chunk = (content) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
        res.write(chunk('Hello'));
        res.write(chunk(', world'));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

/** Boot server.js and wait until /api/health answers. */
async function startApp(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      OPENAI_API_KEY: 'sk-integration-test-key',
      OPENAI_MODEL: 'test-model',
      APP_URL: '',
      SHARED_SECRET: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${log}`);
    }
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, port, base, getLog: () => log };
}

/** Read an SSE response to completion (or until the deadline). */
async function readStream(res, timeoutMs = 10_000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/* ── Suite ───────────────────────────────────────────────────────────── */

describe('integration — SSE contract between server and browser', () => {
  const upstreamCalls = [];
  let stub;
  let app;

  before(async () => {
    stub = await startStubUpstream(upstreamCalls);
    app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1` });
  });

  after(async () => {
    if (app?.child && app.child.exitCode === null) app.child.kill('SIGKILL');
    await new Promise((r) => stub.srv.close(r));
  });

  it('boots and serves GET /api/health', async () => {
    const res = await fetch(`${app.base}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.model, 'test-model', 'health should report the configured model');
  });

  it('serves the frontend from ./public at /', async () => {
    const res = await fetch(`${app.base}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /<script[^>]+app\.js/, 'index.html should load app.js');
  });

  it('returns JSON 404 for unknown /api routes', async () => {
    const res = await fetch(`${app.base}/api/does-not-exist`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Not found' });
  });

  it('streams named SSE events the browser can parse', async () => {
    const res = await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    assert.strictEqual(res.headers.get('x-accel-buffering'), 'no', 'proxies must not buffer the stream');

    const raw = await readStream(res);

    // The exact bytes public/app.js is written to parse.
    assert.match(raw, /event: delta\ndata: \{"token":"Hello"\}/, 'first delta event missing/misshaped');
    assert.match(raw, /event: delta\ndata: \{"token":", world"\}/, 'second delta event missing/misshaped');
    assert.match(raw, /event: done\ndata: \{\}/, 'terminating done event missing');

    // Regression guard: the old client looked for raw OpenAI chunks. If the
    // server ever emits that shape instead, the two must be reconciled.
    assert.ok(!/"choices"/.test(raw), 'server should translate upstream chunks, not forward them raw');
  });

  it('prepends the system prompt and forwards client history upstream', async () => {
    upstreamCalls.length = 0;
    const res = await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'remember me' }] })
    });
    await readStream(res);

    assert.strictEqual(upstreamCalls.length, 1, 'expected exactly one upstream call');
    const sent = upstreamCalls[0];
    assert.match(sent.url, /\/v1\/chat\/completions$/);
    assert.strictEqual(sent.body.messages[0].role, 'system');
    assert.strictEqual(sent.body.messages[1].content, 'remember me');
    assert.strictEqual(sent.body.stream, true, 'must request a streamed completion');
    assert.match(sent.auth || '', /^Bearer sk-integration-test-key$/, 'API key must travel server-side only');
  });

  it('reports invalid payloads as an SSE error event, not a hang', async () => {
    const res = await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    });
    const raw = await readStream(res, 5_000);
    assert.match(raw, /event: error/);
    assert.match(raw, /messages array is required/);
  });

  it('enforces the shared secret when one is configured', async () => {
    const stub2Calls = [];
    const stub2 = await startStubUpstream(stub2Calls);
    const guarded = await startApp({
      OPENAI_BASE_URL: `http://127.0.0.1:${stub2.port}/v1`,
      SHARED_SECRET: 's3cret'
    });
    try {
      const denied = await fetch(`${guarded.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.strictEqual(denied.status, 401, 'request without the secret must be rejected');
      assert.strictEqual(stub2Calls.length, 0, 'no upstream spend on unauthorised requests');

      const allowed = await fetch(`${guarded.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shared-secret': 's3cret' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.strictEqual(allowed.status, 200);
      await readStream(allowed);
    } finally {
      if (guarded.child.exitCode === null) guarded.child.kill('SIGKILL');
      await new Promise((r) => stub2.srv.close(r));
    }
  });
});

describe('integration — container lifecycle', () => {
  it('exits 0 on SIGTERM (so orchestrators stop it cleanly)', async () => {
    const calls = [];
    const stub = await startStubUpstream(calls);
    const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1` });

    const exited = new Promise((resolve) => app.child.once('exit', (code, signal) => resolve({ code, signal })));
    app.child.kill('SIGTERM');

    const result = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 12_000))
    ]);

    await new Promise((r) => stub.srv.close(r));
    if (app.child.exitCode === null) app.child.kill('SIGKILL');

    assert.strictEqual(result.code, 0, `expected clean exit, got ${JSON.stringify(result)}`);
    assert.match(app.getLog(), /shutting down gracefully/i);
  });

  it('refuses to start without an API key (fail fast, not half-up)', async () => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: '', PORT: String(await freePort()) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => child.once('exit', r));
    assert.strictEqual(code, 1, 'missing key must exit non-zero');
    assert.match(err, /OPENAI_API_KEY is not set/);
  });
});

describe('integration — frontend parser matches the server wire format', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  it('reads named SSE event lines', () => {
    assert.ok(appSrc.includes("line.startsWith('event: ')"), 'client ignores event: lines — deltas will never render');
  });

  it('reads the {token} payload the server sends', () => {
    assert.ok(/parsed\.token/.test(appSrc), 'client does not read parsed.token');
  });

  it('skips keep-alive comments', () => {
    assert.ok(appSrc.includes("line.startsWith(':')"), 'client must ignore `: ping` heartbeat lines');
  });

  it('passes a declared AbortController signal to fetch', () => {
    // The original bug: `signal: streamAbortControllerController.signal` —
    // undefined identifier, so every send threw ReferenceError. A substring
    // assertion missed it; this checks the identifier is actually declared.
    const used = /signal:\s*([A-Za-z_$][\w$]*)\.signal/.exec(appSrc);
    assert.ok(used, 'fetch() is not passed an abort signal');
    const declared = new RegExp(`(var|let|const)\\s+${used[1]}\\b`).test(appSrc);
    assert.ok(declared, `fetch() uses undeclared identifier "${used[1]}"`);
  });
});
