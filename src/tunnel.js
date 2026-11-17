'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// api.trycloudflare.com appears in some error messages; it is not the tunnel URL.
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const ERR_RE = /\bERR\b|\bFTL\b|failed to|unable to|error/i;

function parseUrl(line) {
  const m = URL_RE.exec(line);
  return m ? m[0].toLowerCase() : null;
}

/** Find cloudflared: explicit path, bundled copy, then PATH (resolved manually, no shell). */
function findCloudflared(explicitPath, extraDirs = []) {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (explicitPath) return fs.existsSync(explicitPath) ? explicitPath : null;
  for (const d of extraDirs) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
function measureLatency(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = https.request(url, { method: 'HEAD', agent, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(Number((process.hrtime.bigint() - t0) / 1000000n));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Events: 'url'(url), 'log'(line), 'problem'(message), 'latency'(ms|null), 'exit'(code, signal)
 */
class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.url = null;
    this.latencyTimer = null;
  }

  get running() { return !!this.child; }

  /** Resolves once the process has spawned; rejects if it cannot be started. */
  start(command, port) {
    if (this.child) return Promise.reject(new Error('Tunnel is already running.'));
    const args = ['tunnel', '--url', `http://127.0.0.1:${Number(port)}`, '--no-autoupdate'];
    return new Promise((resolve, reject) => {
      // shell:false + argument array: no string interpolation. windowsHide: no console window.
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let spawned = false;
      child.once('spawn', () => { spawned = true; resolve(); });
      child.once('error', (err) => {
        this.child = null;
        const msg = err.code === 'ENOENT' ? 'cloudflared was not found. Locate cloudflared.exe or install it.' : `Could not start cloudflared: ${err.message}`;
        if (!spawned) reject(new Error(msg)); else this.emit('problem', msg);
      });
      const onData = (buf) => {
        for (const line of buf.toString('utf8').split(/\r?\n/)) {
          const text = line.trim();
          if (!text) continue;
          this.emit('log', text);
          const url = !this.url && parseUrl(text);
          if (url) { this.url = url; this.emit('url', url); this._startLatency(); }
          else if (!this.url && ERR_RE.test(text)) this.emit('problem', text.slice(0, 300));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code, signal) => {
        this._stopLatency();
        if (this.child === child) this.child = null;
        this.url = null;
        this.emit('exit', code, signal);
      });
    });
  }

  _startLatency() {
    const tick = async () => {
      if (!this.url) return;
      const ms = await measureLatency(this.url);
      if (this.url) this.emit('latency', ms);
    };
    tick();
    this.latencyTimer = setInterval(tick, 5000);
  }
  _stopLatency() { clearInterval(this.latencyTimer); this.latencyTimer = null; }

  /** Stops only the process this instance started. */
  stop(timeoutMs = 3000) {
    const child = this.child;
    this._stopLatency();
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
      child.once('exit', () => { clearTimeout(force); resolve(); });
      try { child.kill(); } catch { clearTimeout(force); resolve(); }
    });
  }

  /** Synchronous best-effort kill for process 'exit' handlers. */
  killNow() { try { this.child?.kill('SIGKILL'); } catch {} }
}

module.exports = { TunnelManager, parseUrl, findCloudflared, measureLatency };
