/**
 * ============================================================
 *  Runtime tests — Aaron AI Chat
 *  ------------------------------------------------------------
 *  These drive the REAL Express app, not the text of server.js.
 *  Most run in-process on an ephemeral port via the exported
 *  `createApp()`; the few that need a real process (fail-fast
 *  boot, SIGTERM) spawn `node server.js`.
 *
 *  Hermetic by design: the OpenAI-compatible upstream is stubbed
 *  on localhost, so there is no network call, no API key and no
 *  GPU spend.
 * ============================================================
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

process.env.LOG_REQUESTS = 'false'; // keep test output readable

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const { createApp } = require('../server.js');

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** Start an Express app on an ephemeral port. */
async function listen(expressApp) {
  const server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
}

/** Ask the OS for a free TCP port (for child-process tests). */
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
 * Minimal OpenAI-compatible upstream: streams content deltas then [DONE],
 * and records what it was sent.
 */
async function startStubUpstream(received, tokens = ['Hello', ', world']) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: safeJson(body), auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const content of tokens) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, baseURL: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((r) => srv.close(r)) };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
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

/* ── 1. Boot, health, readiness, static ──────────────────────────────── */

describe('runtime — boot, health and static frontend', () => {
  let configured;
  let unconfigured;

  before(async () => {
    configured = await listen(createApp({ apiKey: 'sk-test-key', model: 'test-model' }));
    unconfigured = await listen(createApp({ apiKey: '', model: 'test-model' }));
  });

  after(async () => {
    await configured.close();
    await unconfigured.close();
  });

  it('GET /api/health returns 200 with the configured model', async () => {
    const res = await fetch(`${configured.base}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, model: 'test-model', configured: true });
  });

  it('GET /api/health still answers 200 without credentials (liveness)', async () => {
    const res = await fetch(`${unconfigured.base}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.configured, false, 'health must report missing credentials');
  });

  it('GET /api/ready is 200 when configured, 503 when not (readiness)', async () => {
    const ok = await fetch(`${configured.base}/api/ready`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).ready, true);

    const notOk = await fetch(`${unconfigured.base}/api/ready`);
    assert.strictEqual(notOk.status, 503, 'a credential-less instance must not report ready');
    assert.match((await notOk.json()).error, /OPENAI_API_KEY/);
  });

  it('GET / serves the frontend from ./public', async () => {
    const res = await fetch(`${configured.base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<script[^>]+app\.js/, 'index.html should load app.js');
    for (const id of ['messages', 'composer', 'send-btn']) {
      assert.match(html, new RegExp(`id="${id}"`), `chat UI element #${id} missing from index.html`);
    }
  });

  it('GET /style.css serves static assets', async () => {
    const res = await fetch(`${configured.base}/style.css`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/css/);
  });

  it('sets Helmet security headers on the frontend', async () => {
    const res = await fetch(`${configured.base}/`);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.ok(res.headers.get('x-content-type-options'), 'nosniff header missing');
  });

  it('GET /api/unknown returns a JSON 404', async () => {
    const res = await fetch(`${configured.base}/api/does-not-exist`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Not found' });
  });
});

/* ── 2. The SSE contract the browser depends on ──────────────────────── */

describe('runtime — SSE chat contract', () => {
  const upstreamCalls = [];
  let stub;
  let app;

  before(async () => {
    stub = await startStubUpstream(upstreamCalls);
    app = await listen(createApp({ apiKey: 'sk-test-key', baseURL: stub.baseURL, model: 'test-model' }));
  });

  after(async () => {
    await app.close();
    await stub.close();
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
    assert.match(res.headers.get('cache-control') || '', /no-cache/);

    const raw = await readStream(res);
    assert.match(raw, /event: delta\ndata: \{"token":"Hello"\}/, 'first delta event missing/misshaped');
    assert.match(raw, /event: delta\ndata: \{"token":", world"\}/, 'second delta event missing/misshaped');
    assert.match(raw, /event: done\ndata: \{\}/, 'terminating done event missing');
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
    assert.strictEqual(sent.body.model, 'test-model');
    assert.match(sent.auth || '', /^Bearer sk-test-key$/, 'API key must travel server-side only');
  });

  it('reports an invalid payload as an SSE error event, not a hang', async () => {
    const res = await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    });
    const raw = await readStream(res, 5_000);
    assert.match(raw, /event: error/);
    assert.match(raw, /messages array is required/);
  });
});

/* ── 3. Security boundaries ──────────────────────────────────────────── */

describe('runtime — security', () => {
  it('returns 503 (not a silent empty stream) when no API key is configured', async () => {
    const instance = await listen(createApp({ apiKey: '' }));
    try {
      const res = await fetch(`${instance.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.strictEqual(res.status, 503);
      assert.match((await res.json()).error, /OPENAI_API_KEY is missing/);
    } finally {
      await instance.close();
    }
  });

  it('treats the .env.example placeholder key as unconfigured', async () => {
    const instance = await listen(createApp({ apiKey: 'sk-your-secret-api-key-here' }));
    try {
      assert.strictEqual((await fetch(`${instance.base}/api/ready`)).status, 503);
    } finally {
      await instance.close();
    }
  });

  it('enforces the shared secret when one is configured', async () => {
    const calls = [];
    const stub = await startStubUpstream(calls);
    const instance = await listen(createApp({
      apiKey: 'sk-test-key',
      baseURL: stub.baseURL,
      sharedSecret: 's3cret'
    }));
    try {
      const denied = await fetch(`${instance.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.strictEqual(denied.status, 401, 'request without the secret must be rejected');
      assert.strictEqual(calls.length, 0, 'no upstream spend on unauthorised requests');

      const allowed = await fetch(`${instance.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shared-secret': 's3cret' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.strictEqual(allowed.status, 200);
      await readStream(allowed);
    } finally {
      await instance.close();
      await stub.close();
    }
  });

  it('rate limits before the secret check, so the secret cannot be brute forced', async () => {
    // Deliberate ordering (see the comment above app.post('/api/chat')):
    // the limiter runs FIRST, so failed authentication attempts are throttled
    // rather than being free to repeat forever.
    const calls = [];
    const stub = await startStubUpstream(calls);
    const instance = await listen(createApp({
      apiKey: 'sk-test-key',
      baseURL: stub.baseURL,
      sharedSecret: 's3cret'
    }));
    try {
      const statuses = [];
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${instance.base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-shared-secret': 'guess' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        statuses.push(res.status);
        await res.text(); // drain
      }

      assert.ok(statuses.includes(401), 'a wrong secret must be rejected');
      const firstThrottled = statuses.indexOf(429);
      assert.notStrictEqual(firstThrottled, -1, 'repeated wrong-secret attempts were never throttled');
      assert.ok(
        firstThrottled <= 20,
        `throttling started at attempt ${firstThrottled + 1}; the limiter should cap the window at 20`
      );
      assert.strictEqual(calls.length, 0, 'no upstream spend during a brute-force attempt');
    } finally {
      await instance.close();
      await stub.close();
    }
  });

  it('never exposes the API key to the browser', async () => {
    const stub = await startStubUpstream([]);
    const instance = await listen(createApp({ apiKey: 'sk-super-secret-value', baseURL: stub.baseURL }));
    try {
      const html = await (await fetch(`${instance.base}/`)).text();
      const js = await (await fetch(`${instance.base}/app.js`)).text();
      const health = await (await fetch(`${instance.base}/api/health`)).text();
      for (const [name, body] of [['index.html', html], ['app.js', js], ['/api/health', health]]) {
        assert.ok(!body.includes('sk-super-secret-value'), `API key leaked in ${name}`);
      }
    } finally {
      await instance.close();
      await stub.close();
    }
  });
});

/* ── 4. The browser parser, replayed against real server bytes ───────── */

describe('runtime — public/app.js renders the stream it is sent', () => {
  it('produces the assistant text from a real SSE response', async () => {
    const stub = await startStubUpstream([], ['Hello', ', ', '**world**']);
    const instance = await listen(createApp({ apiKey: 'sk-test-key', baseURL: stub.baseURL }));
    try {
      const response = await fetch(`${instance.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });

      // Lift the stream-parsing loop out of the browser bundle and run it
      // against the live response. A DOM is not needed: the loop's only
      // outputs are `fullText` and two render callbacks.
      const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const START = 'var reader = response.body.getReader();';
      const END = "hist.push({ role: 'assistant'";
      const from = src.indexOf(START);
      const to = src.indexOf(END);
      assert.ok(
        from !== -1 && to > from,
        'could not locate the stream-parsing loop in public/app.js — update the START/END anchors in this test'
      );

      const parseLoop = new Function(
        'response', 'renderMarkdown', 'scrollToBottom', 'aiInner', 'state',
        `return (async () => {
           let fullText = '';
           let userScrolledUp = false;
           ${src.slice(from, to)}
           state.text = fullText;
         })()`
      );

      const state = {};
      await parseLoop(response, () => {}, () => {}, {}, state);

      assert.strictEqual(
        state.text,
        'Hello, **world**',
        'the client parser did not reconstruct the assistant message from the server stream'
      );
    } finally {
      await instance.close();
      await stub.close();
    }
  });

  it('passes a declared AbortController signal to fetch', () => {
    // Regression guard for `streamAbortControllerController.signal` — an
    // undefined identifier that made every send throw. The parse-loop test
    // above starts after the fetch call, so this checks it statically.
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const used = /signal:\s*([A-Za-z_$][\w$]*)\.signal/.exec(appSrc);
    assert.ok(used, 'fetch() is not passed an abort signal');
    assert.ok(
      new RegExp(`(var|let|const)\\s+${used[1]}\\b`).test(appSrc),
      `fetch() uses undeclared identifier "${used[1]}"`
    );
  });
});

/* ── 5. Process-level behaviour (needs a real child process) ─────────── */

describe('process — CLI startup and shutdown', () => {
  /** Spawn `node server.js` and wait until it answers /api/health. */
  async function spawnServer(env = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', OPENAI_API_KEY: '', APP_URL: '', SHARED_SECRET: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch (_) { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return { child, base, getLog: () => log };
  }

  it('`node server.js` boots and serves health without credentials', async () => {
    const app = await spawnServer({ OPENAI_MODEL: 'cli-model' });
    try {
      const body = await (await fetch(`${app.base}/api/health`)).json();
      assert.deepStrictEqual(body, { ok: true, model: 'cli-model', configured: false });
      assert.match(app.getLog(), /OPENAI_API_KEY is not set/, 'startup should warn loudly about the missing key');
    } finally {
      app.child.kill('SIGKILL');
    }
  });

  it('REQUIRE_API_KEY=true restores fail-fast boot (exit 1)', async () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: '', REQUIRE_API_KEY: 'true', PORT: String(await freePort()) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => child.once('exit', r));
    assert.strictEqual(code, 1, 'missing key with REQUIRE_API_KEY=true must exit non-zero');
    assert.match(err, /OPENAI_API_KEY is not set/);
  });

  it('exits 0 on SIGTERM so orchestrators stop it cleanly', async () => {
    const app = await spawnServer({ OPENAI_API_KEY: 'sk-test-key' });
    const exited = new Promise((resolve) => app.child.once('exit', (code) => resolve(code)));
    app.child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 12_000))]);
    if (app.child.exitCode === null) app.child.kill('SIGKILL');
    assert.strictEqual(code, 0, `expected clean exit, got ${code}`);
    assert.match(app.getLog(), /shutting down gracefully/i);
  });

  it('does not listen when required as a module', async () => {
    const probe = `
      const m = require(${JSON.stringify(SERVER_PATH)});
      const exported = Object.keys(m).sort().join(',');
      if (!m.app || typeof m.createApp !== 'function') { console.log('MISSING_EXPORTS:' + exported); process.exit(2); }
      // If require() had called listen(), the event loop would keep this alive.
      setTimeout(() => { console.log('STILL_LISTENING'); process.exit(3); }, 400).unref();
      console.log('CLEAN_EXIT:' + exported);
    `;
    const child = spawn(process.execPath, ['-e', probe], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-key' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.once('exit', r));
    assert.strictEqual(code, 0, `requiring server.js should exit cleanly, got ${code}: ${out}`);
    assert.match(out, /CLEAN_EXIT:.*createApp/);
  });
});
