'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStaticServer, listenLoopback, closeServer } = require('./staticServer');
const { TunnelManager, findCloudflared } = require('./tunnel');

const URL_TIMEOUT_MS = 45000;
const MAX_LOG = 200;

function validate({ folder, port }) {
  if (!folder || typeof folder !== 'string') return 'Select a website folder first.';
  let st;
  try { st = fs.statSync(folder); } catch { return 'The selected folder does not exist.'; }
  if (!st.isDirectory()) return 'The selected path is not a folder.';
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return 'Enter a local port between 1024 and 65535.';
  return null;
}

class DarkyController extends EventEmitter {
  /** @param {{extraDirs?: string[]}} opts directories searched for a bundled cloudflared */
  constructor(opts = {}) {
    super();
    this.extraDirs = opts.extraDirs || [];
    this.server = null;
    this.tunnel = null;
    this.urlTimer = null;
    this.busy = false;
    this.state = this._initial();
  }

  _initial() {
    return {
      website: { status: 'stopped', message: 'Stopped' },
      tunnel: { status: 'stopped', message: 'Stopped' },
      publicUrl: null, port: null, folder: null, latencyMs: null,
      cloudflaredPath: null, warning: null, error: null, log: [],
    };
  }

  getState() { return JSON.parse(JSON.stringify(this.state)); }
  _set(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()); }
  _log(line) {
    this.state.log.push(line);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    this.emit('state', this.getState());
  }

  async start({ folder, port, cloudflaredPath }) {
    if (this.busy || this.server) return { ok: false, error: 'DarkyDesk is already running.' };
    const bad = validate({ folder, port });
    if (bad) { this._set({ error: bad }); return { ok: false, error: bad }; }
    this.busy = true;
    port = Number(port);
    const hasIndex = fs.existsSync(path.join(folder, 'index.html'));
    this.state = { ...this._initial(), folder, port,
      warning: hasIndex ? null : 'This folder has no index.html. The home page will return 404.',
      website: { status: 'starting', message: 'Starting…' },
      tunnel: { status: 'starting', message: 'Starting…' } };
    this.emit('state', this.getState());

    try {
      this.server = createStaticServer(folder);
      await listenLoopback(this.server, port);
    } catch (err) {
      this.server = null;
      this._set({ website: { status: 'error', message: err.message }, tunnel: { status: 'stopped', message: 'Stopped' }, error: err.message });
      this.busy = false;
      return { ok: false, error: err.message };
    }
    this._set({ website: { status: 'running', message: `Serving on http://127.0.0.1:${port}` } });

    const exe = findCloudflared(cloudflaredPath, this.extraDirs);
    if (!exe) {
      const msg = 'cloudflared was not found. Click "Locate cloudflared.exe" or install it (see Setup).';
      this._set({ tunnel: { status: 'error', message: msg }, error: msg });
      this.busy = false;
      return { ok: true, tunnelStarted: false };
    }
    this._set({ cloudflaredPath: exe });

    const t = (this.tunnel = new TunnelManager());
    t.on('log', (l) => this._log(l));
    t.on('url', (u) => {
      clearTimeout(this.urlTimer);
      this._set({ publicUrl: u, error: null, tunnel: { status: 'connected', message: 'Connected' } });
    });
    t.on('problem', (m) => {
      if (this.state.tunnel.status !== 'connected') this._set({ tunnel: { status: 'starting', message: `Starting… last message: ${m}` }, error: m });
    });
    t.on('latency', (ms) => this._set({ latencyMs: ms }));
    t.on('exit', (code, signal) => {
      clearTimeout(this.urlTimer);
      if (this.tunnel !== t) return; // intentional stop already handled
      this.tunnel = null;
      const msg = `cloudflared exited unexpectedly (${signal || 'code ' + code}).`;
      this._set({ publicUrl: null, latencyMs: null, tunnel: { status: 'error', message: msg }, error: this.state.error || msg });
    });

    try {
      await t.start(exe, port);
    } catch (err) {
      this.tunnel = null;
      this._set({ tunnel: { status: 'error', message: err.message }, error: err.message });
      this.busy = false;
      return { ok: true, tunnelStarted: false };
    }
    this.urlTimer = setTimeout(() => {
      if (!this.state.publicUrl) {
        this._set({ tunnel: { status: 'error', message: 'No public URL after 45 seconds. Check your internet connection and the log below.' } });
      }
    }, URL_TIMEOUT_MS);
    this.busy = false;
    return { ok: true, tunnelStarted: true };
  }

  async stop() {
    clearTimeout(this.urlTimer);
    const t = this.tunnel; this.tunnel = null;
    const s = this.server; this.server = null;
    await Promise.all([t ? t.stop() : null, closeServer(s)]);
    this.busy = false;
    this.state = { ...this._initial(), folder: this.state.folder, port: this.state.port, log: this.state.log };
    this.emit('state', this.getState());
    return { ok: true };
  }

  /** Synchronous last-resort cleanup for process exit. */
  killNow() { this.tunnel?.killNow(); try { this.server?.close(); } catch {} }
}

module.exports = { DarkyController, validate };
