/**
 * Same-origin bridge for the MetaInfer trajectory workspace.
 *
 * The browser only ever talks to the DSH Web origin.  This module serves the
 * small standalone UI bundle and proxies the trajectory REST prefix to the
 * local MetaInfer backend.  No second tab, port or URL is exposed to the user.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ASSET_PREFIX = '/metainfer/trajectory-assets';
const API_PREFIX = '/api/sys-shell/trajectories';
const BACKEND = { host: '127.0.0.1', port: 8765 };
const PLATFORM_ROOT = process.env.METAINFER_ROOT || '/home/MetaInfer';
const STATIC_DIR = path.join(PLATFORM_ROOT, 'metainfer', 'tasks', 'sys_shell', 'static');

function rewriteModule(file, replacements) {
  let text = readFileSync(path.join(STATIC_DIR, file), 'utf8');
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text;
}

const MOUNT_MODULE = `
import { html, render } from "${ASSET_PREFIX}/htm.js";
import { TrajectoryView } from "${ASSET_PREFIX}/trajectory.js";

export function mount(element, props = {}) {
  render(html\`<\${TrajectoryView}
    projectId=\${props.projectId || ""}
    projectName=\${props.projectName || ""}
    repoPath=\${props.repoPath || ""}
  />\`, element);
  return () => render(null, element);
}
`;

function assets() {
  return new Map([
    ['mount.js', {
      type: 'text/javascript; charset=utf-8',
      body: MOUNT_MODULE,
    }],
    ['trajectory.js', {
      type: 'text/javascript; charset=utf-8',
      body: rewriteModule('views/trajectory.js', [
        ['from "htm/preact"', `from "${ASSET_PREFIX}/htm.js"`],
        ['from "preact/hooks"', `from "${ASSET_PREFIX}/preact-hooks.js"`],
      ]),
    }],
    ['trajectory.css', {
      type: 'text/css; charset=utf-8',
      body: readFileSync(path.join(STATIC_DIR, 'trajectory.css'), 'utf8'),
    }],
    ['preact.js', {
      type: 'text/javascript; charset=utf-8',
      body: readFileSync(path.join(STATIC_DIR, 'vendor', 'preact.js'), 'utf8'),
    }],
    ['preact-hooks.js', {
      type: 'text/javascript; charset=utf-8',
      body: rewriteModule('vendor/preact-hooks.js', [
        ['from"preact"', `from"${ASSET_PREFIX}/preact.js"`],
      ]),
    }],
    ['htm.js', {
      type: 'text/javascript; charset=utf-8',
      body: rewriteModule('vendor/htm.js', [
        ['from"preact"', `from"${ASSET_PREFIX}/preact.js"`],
        ['from"htm"', `from"${ASSET_PREFIX}/htm-core.js"`],
      ]),
    }],
    ['htm-core.js', {
      type: 'text/javascript; charset=utf-8',
      body: readFileSync(path.join(STATIC_DIR, 'vendor', 'htm-core.js'), 'utf8'),
    }],
  ]);
}

function assetHandler(cache) {
  return (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const rel = pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, '');
    const item = cache.get(rel);
    if (!item) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': item.type,
      'cache-control': 'no-store',
    });
    res.end(item.body);
  };
}

function proxyHandler(req, res) {
  const upstream = http.request(
    {
      host: BACKEND.host,
      port: BACKEND.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` },
    },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      detail: `MetaInfer trajectory backend unavailable: ${error.message}`,
    }));
  });
  req.pipe(upstream);
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{ register(route: object): () => void }} webServer
 */
export function registerTrajectoryWeb(ctx, webServer) {
  const cache = assets();
  const disposers = [
    webServer.register({ kind: 'prefix', path: ASSET_PREFIX, handler: assetHandler(cache) }),
    webServer.register({ kind: 'prefix', path: API_PREFIX, handler: proxyHandler }),
  ];
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* already gone */ }
    }
  };
}
