/**
 * ============================================================
 *  Repository configuration tests — Aaron AI Chat
 *  ------------------------------------------------------------
 *  Scope deliberately narrowed: this file used to assert that
 *  certain STRINGS appeared in server.js and public/app.js, which
 *  gave false confidence (it passed while the app was broken at
 *  runtime). Behaviour is now covered by tests/integration.test.js;
 *  what remains here are checks on files that cannot be exercised
 *  at runtime — env templates, ignore files, deploy config, and
 *  the toolchain version contract.
 * ============================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const lines = (s) => s.split('\n').map((l) => l.trim());

/** Lowest major version accepted by a simple `>=x.y.z` range. */
function minMajor(range) {
  const m = /(\d+)/.exec(String(range));
  return m ? Number(m[1]) : NaN;
}

describe('.env.example — documents every setting the server reads', () => {
  const env = read('.env.example');

  it('lists all required keys', () => {
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'PORT', 'HOST']) {
      assert.match(env, new RegExp(`^${key}=`, 'm'), `${key} missing from .env.example`);
    }
  });

  it('uses the Dahl Inference base URL and DeepSeek model as defaults', () => {
    assert.ok(env.includes('https://inference.dahl.global/v1'), 'Dahl base URL missing');
    assert.ok(env.includes('deepseek-ai/DeepSeek-V4-Flash-0731'), 'default model missing');
  });

  it('ships a recognisable placeholder rather than a real key', () => {
    const line = env.split('\n').find((l) => l.startsWith('OPENAI_API_KEY='));
    assert.ok(line, 'OPENAI_API_KEY line missing');
    assert.ok(line.includes('sk-your-secret-api-key-here'), 'placeholder key changed');
  });

  it('documents the env vars the server actually reads (no stale names)', () => {
    const declared = env
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0]);
    const serverSrc = read('server.js');
    for (const key of declared) {
      assert.ok(
        serverSrc.includes(`process.env.${key}`),
        `.env.example documents ${key}, but server.js never reads it`
      );
    }
  });
});

describe('secrets never leave the machine', () => {
  it('.env is git-ignored', () => {
    assert.ok(lines(read('.gitignore')).includes('.env'), '.env is not in .gitignore — SECURITY RISK');
  });

  it('node_modules/ and *.log are git-ignored', () => {
    const ignored = lines(read('.gitignore'));
    assert.ok(ignored.includes('node_modules/'), 'node_modules/ not ignored');
    assert.ok(ignored.includes('*.log'), '*.log not ignored');
  });

  it('.env is excluded from the Docker build context', () => {
    assert.ok(lines(read('.dockerignore')).includes('.env'), '.env could be baked into an image layer');
  });

  it('package-lock.json is committed (reproducible installs)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'lockfile missing');
    assert.ok(
      !lines(read('.gitignore')).some((l) => l.startsWith('package-lock.json')),
      'package-lock.json must not be ignored'
    );
  });
});

describe('package.json — single source of truth for commands', () => {
  const pkg = JSON.parse(read('package.json'));

  it('exposes start, dev, test and lint scripts', () => {
    for (const script of ['start', 'dev', 'test', 'lint']) {
      assert.ok(pkg.scripts?.[script], `"${script}" script missing`);
    }
  });

  it('pre-commit chains lint and test', () => {
    const hook = pkg.scripts?.['pre-commit'] || '';
    assert.ok(hook.includes('lint') && hook.includes('test'), 'pre-commit should run lint && test');
  });

  it('ESLint is a real devDependency, not an ad-hoc CI install', () => {
    assert.ok(pkg.devDependencies?.eslint, 'eslint missing from devDependencies');
  });

  it('declares an explicit Node engine range', () => {
    assert.ok(pkg.engines?.node, 'engines.node missing');
    assert.ok(Number.isFinite(minMajor(pkg.engines.node)), `unparseable engines.node: ${pkg.engines.node}`);
  });
});

describe('toolchain versions agree across package.json, Docker and CI', () => {
  const pkg = JSON.parse(read('package.json'));
  const engineMin = minMajor(pkg.engines.node);
  const ci = read(path.join('.github', 'workflows', 'ci.yml'));
  const dockerfile = read('Dockerfile');

  it('the CI matrix only tests versions the package claims to support', () => {
    const matrix = /node-version:\s*\[([^\]]+)\]/.exec(ci);
    assert.ok(matrix, 'could not find the node-version matrix in ci.yml');
    const versions = matrix[1].split(',').map((v) => Number(v.replace(/['"\s]/g, '')));
    assert.ok(versions.length > 0, 'empty CI matrix');
    for (const v of versions) {
      assert.ok(v >= engineMin, `CI tests Node ${v}, below the declared engines.node (>=${engineMin})`);
    }
    // engine-strict=true makes an unsupported version a hard install failure,
    // so the floor must be a version CI actually proves.
    assert.strictEqual(
      Math.min(...versions),
      engineMin,
      `engines.node claims >=${engineMin} but the lowest version CI tests is ${Math.min(...versions)}`
    );
  });

  it('the Docker base image satisfies the declared engine range', () => {
    const from = /FROM node:(\d+)/.exec(dockerfile);
    assert.ok(from, 'could not read the Node major from the Dockerfile FROM line');
    assert.ok(
      Number(from[1]) >= engineMin,
      `Dockerfile uses node:${from[1]} but engines.node requires >=${engineMin}`
    );
  });

  it('the production image installs without dev dependencies', () => {
    assert.match(dockerfile, /npm ci[^\n]*--omit=dev/, 'Docker build should use `npm ci --omit=dev`');
  });

  it('.npmrc does not force omit=dev on every install', () => {
    const npmrc = read('.npmrc')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    assert.ok(
      !/^\s*omit\s*=\s*dev/m.test(npmrc),
      '.npmrc sets omit=dev, which strips lint/test tooling from `npm ci` in CI'
    );
  });
});

describe('vercel.json — kept working as a best-effort target', () => {
  const vercel = JSON.parse(read('vercel.json'));

  it('builds server.js with @vercel/node', () => {
    assert.ok(vercel.builds?.some((b) => b.use === '@vercel/node'), '@vercel/node builder missing');
  });

  it('routes /api/* and static requests through server.js', () => {
    const api = vercel.routes?.find((r) => r.src === '/api/(.*)');
    const statics = vercel.routes?.find((r) => r.src === '/(.*)');
    assert.strictEqual(api?.dest, '/server.js', 'API route should target /server.js');
    assert.strictEqual(statics?.dest, '/server.js', 'static catch-all should target /server.js');
  });

  it('disables proxy buffering and caching on API routes so SSE can stream', () => {
    const api = vercel.routes?.find((r) => r.src === '/api/(.*)');
    assert.strictEqual(api?.headers?.['X-Accel-Buffering'], 'no', 'X-Accel-Buffering: no missing');
    assert.match(api?.headers?.['Cache-Control'] || '', /no-store/, 'Cache-Control should include no-store');
  });
});
