'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { createStaticServer, listenLoopback, closeServer } = require('../src/staticServer');
const { parseUrl } = require('../src/tunnel');
const { DarkyController, validate } = require('../src/controller');

function tmpSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darky-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(site, 'sub', 'index.html'), '<h1>sub</h1>');
  fs.writeFileSync(path.join(site, 'a b.css'), 'body{}');
  fs.writeFileSync(path.join(site, 'app.js'), '1');
  fs.writeFileSync(path.join(site, 'x.svg'), '<svg/>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  return { root, site };
}
function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
// Raw request so the client does not normalise "../" before sending.
function raw(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${method} ${requestPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = ''; s.on('data', (d) => (data += d)); s.on('end', () => resolve(data)); s.on('error', reject);
  });
}
const status = (r) => Number(r.split(' ')[1]);

test('static server: content types, index files, HEAD, binding', async () => {
  const { site } = tmpSite();
  const port = await freePort();
  const srv = createStaticServer(site);
  await listenLoopback(srv, port);
  try {
    assert.strictEqual(srv.address().address, '127.0.0.1');
    const home = await raw(port, '/');
    assert.strictEqual(status(home), 200); assert.match(home, /text\/html; charset=utf-8/); assert.match(home, /<h1>home/);
    assert.match(await raw(port, '/sub/'), /<h1>sub/);
    assert.match(await raw(port, '/app.js'), /text\/javascript/);
    assert.match(await raw(port, '/a%20b.css'), /text\/css/);
    assert.match(await raw(port, '/x.svg'), /image\/svg\+xml/);
    const head = await raw(port, '/', 'HEAD');
    assert.strictEqual(status(head), 200); assert.doesNotMatch(head, /<h1>/);
    assert.strictEqual(status(await raw(port, '/nope.html')), 404);
    assert.strictEqual(status(await raw(port, '/', 'POST')), 405);
  } finally { await closeServer(srv); }
});

test('static server: path traversal is blocked', async () => {
  const { site } = tmpSite();
  const port = await freePort();
  const srv = createStaticServer(site);
  await listenLoopback(srv, port);
  try {
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/sub/../../secret.txt',
      '/..\\secret.txt', '/%5c..%5csecret.txt', '/%00', '/C:/Windows/win.ini', '/%zz']) {
      const r = await raw(port, p);
      assert.notStrictEqual(status(r), 200, `should not serve ${p}`);
      assert.doesNotMatch(r, /TOP SECRET/, `leaked via ${p}`);
    }
  } finally { await closeServer(srv); }
});

test('static server: symlink escaping the root is blocked', { skip: process.platform === 'win32' }, async () => {
  const { root, site } = tmpSite();
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(site, 'link.txt'));
  const port = await freePort();
  const srv = createStaticServer(site);
  await listenLoopback(srv, port);
  try {
    const r = await raw(port, '/link.txt');
    assert.strictEqual(status(r), 403); assert.doesNotMatch(r, /TOP SECRET/);
  } finally { await closeServer(srv); }
});

test('port in use gives a readable error', async () => {
  const { site } = tmpSite();
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const srv = createStaticServer(site);
  await assert.rejects(listenLoopback(srv, port), /already in use/);
  blocker.close();
});

test('parseUrl extracts the quick tunnel URL and ignores the API host', () => {
  assert.strictEqual(parseUrl('INF |  https://random-words-here.trycloudflare.com  |'), 'https://random-words-here.trycloudflare.com');
  assert.strictEqual(parseUrl('Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup failed'), null);
  assert.strictEqual(parseUrl('nothing here'), null);
});

test('validate rejects bad input', () => {
  const { site } = tmpSite();
  assert.ok(validate({ folder: '', port: 8080 }));
  assert.ok(validate({ folder: path.join(site, 'missing'), port: 8080 }));
  assert.ok(validate({ folder: site, port: 80 }));
  assert.ok(validate({ folder: site, port: 'abc' }));
  assert.strictEqual(validate({ folder: site, port: 8080 }), null);
});

function fakeCloudflared(dir, body) {
  const f = path.join(dir, 'cloudflared');
  fs.writeFileSync(f, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  return f;
}

test('controller: serves site, extracts URL from fake cloudflared, stop kills only its child', { skip: process.platform === 'win32' }, async () => {
  const { root, site } = tmpSite();
  const argsFile = path.join(root, 'args.json');
  const pidFile = path.join(root, 'pid');
  const exe = fakeCloudflared(root, `
    require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    console.error('2025 INF Requesting new quick Tunnel');
    console.error('2025 INF |  https://fake-demo-test.trycloudflare.com  |');
    setInterval(() => {}, 1000);`);
  // An unrelated process that must survive Stop.
  const bystander = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const port = await freePort();
  const c = new DarkyController();
  try {
    const r = await c.start({ folder: site, port, cloudflaredPath: exe });
    assert.ok(r.ok && r.tunnelStarted);
    await new Promise((res) => { const i = setInterval(() => { if (c.getState().publicUrl) { clearInterval(i); res(); } }, 50); });
    const s = c.getState();
    assert.strictEqual(s.publicUrl, 'https://fake-demo-test.trycloudflare.com');
    assert.strictEqual(s.tunnel.status, 'connected'); assert.strictEqual(s.website.status, 'running');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(argsFile)), ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
    assert.match(await raw(port, '/'), /<h1>home/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await c.stop();
    assert.throws(() => process.kill(pid, 0), 'cloudflared child should be gone');
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'bystander must still be alive');
    await assert.rejects(new Promise((res, rej) => http.get({ port, host: '127.0.0.1', path: '/' }, res).on('error', rej)));
    assert.strictEqual(c.getState().website.status, 'stopped');
  } finally { bystander.kill(); await c.stop(); }
});

test('controller: missing cloudflared keeps website running and reports error', async () => {
  const { site } = tmpSite();
  const port = await freePort();
  const c = new DarkyController();
  const r = await c.start({ folder: site, port, cloudflaredPath: path.join(site, 'nope.exe') });
  try {
    assert.ok(r.ok && !r.tunnelStarted);
    const s = c.getState();
    assert.strictEqual(s.website.status, 'running'); assert.strictEqual(s.tunnel.status, 'error');
    assert.match(s.tunnel.message, /not found/);
  } finally { await c.stop(); }
});

test('controller: cloudflared startup errors and unexpected exit are surfaced', { skip: process.platform === 'win32' }, async () => {
  const { root, site } = tmpSite();
  const exe = fakeCloudflared(root, `console.error('ERR failed to request quick Tunnel: dial tcp: no such host'); process.exit(1);`);
  const port = await freePort();
  const c = new DarkyController();
  try {
    await c.start({ folder: site, port, cloudflaredPath: exe });
    await new Promise((res) => { const i = setInterval(() => { if (c.getState().tunnel.status === 'error') { clearInterval(i); res(); } }, 50); });
    const s = c.getState();
    assert.match(s.error, /failed to request quick Tunnel/);
    assert.strictEqual(s.website.status, 'running');
  } finally { await c.stop(); }
});
