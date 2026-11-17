'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Resolve a request URL to a real file path inside rootReal, or return an
 * { status } error object. rootReal must already be a realpath.
 */
function resolveRequest(rootReal, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return { status: 400 };
  }
  if (pathname.includes('\0')) return { status: 400 };
  // Reject backslashes and drive-letter style segments (Windows traversal tricks).
  if (pathname.includes('\\') || /(^|\/)[a-zA-Z]:/.test(pathname)) return { status: 400 };

  let candidate = path.resolve(rootReal, '.' + path.posix.normalize('/' + pathname));
  try {
    let real = fs.realpathSync(candidate);
    if (fs.statSync(real).isDirectory()) {
      real = fs.realpathSync(path.join(real, 'index.html'));
    }
    const rel = path.relative(rootReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 };
    if (!fs.statSync(real).isFile()) return { status: 404 };
    return { file: real };
  } catch {
    return { status: 404 };
  }
}

function createStaticServer(rootDir) {
  const rootReal = fs.realpathSync(rootDir);
  const server = http.createServer((req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }
    const r = resolveRequest(rootReal, req.url || '/');
    if (!r.file) {
      const text = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found' }[r.status] || 'Error';
      res.writeHead(r.status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    const size = fs.statSync(r.file).size;
    res.writeHead(200, { ...headers, 'Content-Type': contentType(r.file), 'Content-Length': size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(r.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  server.rootReal = rootReal;
  return server;
}

/** Listen on loopback only. Resolves when listening, rejects with a readable error. */
function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') err.message = `Port ${port} is already in use. Choose another port.`;
      else if (err.code === 'EACCES') err.message = `Permission denied for port ${port}. Choose another port.`;
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

module.exports = { createStaticServer, listenLoopback, closeServer, resolveRequest, contentType };
