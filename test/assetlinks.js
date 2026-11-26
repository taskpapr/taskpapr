#!/usr/bin/env node
// Tests the Android Digital Asset Links support: the ANDROID_APP_LINKS parser
// (lib/assetlinks.js) and the /.well-known/assetlinks.json route.
//
//   node test/assetlinks.js
//
// Starts two throwaway servers (temp DBs) in sign-in-required mode, because
// the route must be served before requireAuth: Chrome and Google's verifier
// fetch it without cookies. Node built-ins only. Exit 0 = pass, 1 = fail.

'use strict';

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAppLinks } = require('../lib/assetlinks');

const FP = '58:06:49:F8:F7:81:FD:1D:C9:EA:1C:79:B1:3F:07:69:E1:99:31:0E:43:2C:70:E3:C9:D7:51:A5:7E:E3:AD:3F';
const FP2 = 'AA:'.repeat(31) + 'AA';
let passed = 0;
console.log('assetlinks');
function check(name, fn) { fn(); passed++; console.log(`  ✓  ${name}`); }

// ── Parser ────────────────────────────────────────────────────
check('unset or empty → no statements', () => {
  for (const raw of [undefined, '', '  ,  ']) {
    assert.deepEqual(parseAppLinks(raw), { statements: null, errors: [] });
  }
});

check('valid entries → one statement per package, upper-cased fingerprints', () => {
  const { statements, errors } = parseAppLinks(`com.taskpapr.app=${FP}, com.taskpapr.app.staging=${FP.toLowerCase()}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(statements.map(s => s.target.package_name), ['com.taskpapr.app', 'com.taskpapr.app.staging']);
  for (const s of statements) {
    assert.deepEqual(s.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(s.target.namespace, 'android_app');
    assert.deepEqual(s.target.sha256_cert_fingerprints, [FP]);
  }
});

check('a repeated package collects fingerprints (key rotation), duplicates merged', () => {
  const { statements } = parseAppLinks(`com.a.b=${FP} com.a.b=${FP2} com.a.b=${FP.toLowerCase()}`);
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].target.sha256_cert_fingerprints, [FP, FP2]);
});

check('malformed entries are reported, valid ones kept', () => {
  const bad = ['nonsense', 'com.bad=12:34', `bad-pkg=${FP}`, `nodots=${FP}`, `=${FP}`, 'com.a.b='];
  const { statements, errors } = parseAppLinks([`com.ok.app=${FP}`, ...bad].join(','));
  assert.deepEqual(errors, bad);
  assert.deepEqual(statements.map(s => s.target.package_name), ['com.ok.app']);
});

// ── Route ─────────────────────────────────────────────────────
async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpapr-assetlinks-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      // Sign-in required, so a route behind requireAuth would redirect.
      SINGLE_USER_MODE: 'false', SESSION_SECRET: 'test', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x',
      PORT: String(port), DB_PATH: path.join(dir, 'test.db'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
      if (i > 60) throw new Error(`server did not start:\n${log}`);
      await new Promise(r => setTimeout(r, 250));
    }
    await fn(base, () => log);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await withServer({ ANDROID_APP_LINKS: `com.taskpapr.app.staging=${FP},oops` }, async (base, log) => {
    const res = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: 'manual' });
    check('configured: logged-out GET returns 200 JSON (served before sign-in)', () => {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^application\/json/);
    });
    const body = await res.json();
    check('configured: body lists the package and fingerprint', () => {
      assert.deepEqual(body, parseAppLinks(`com.taskpapr.app.staging=${FP}`).statements);
    });
    check('configured: malformed entries are logged at startup', () => {
      assert.match(log(), /ANDROID_APP_LINKS: ignored 1 malformed entry.*oops/);
    });
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    check('sign-in is still required for the app itself', () => {
      assert.equal(page.status, 302);
      assert.match(page.headers.get('location'), /\/login$/);
    });
  });

  await withServer({ ANDROID_APP_LINKS: '' }, async (base) => {
    const res = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: 'manual' });
    check('unset: 404, not a redirect to /login', () => assert.equal(res.status, 404));
  });

  console.log(`\nassetlinks: all ${passed} checks passed`);
})().catch(err => {
  console.error(`\n  ✗  ${err.message}`);
  process.exit(1);
});
