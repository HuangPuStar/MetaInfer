/**
 * Self-hosted Perfetto UI (issue #94 follow-up).
 *
 * The release build of the Perfetto UI (`perfetto-ui.zip`, ~17 MB) is pinned to
 * a version and served from the DSH origin, so the browser needs no external
 * network and the embedded iframe is same-origin (no Perfetto trust prompt).
 *
 * The zip is NOT vendored in the plugin: `scripts/fetch-perfetto-ui.mjs` unpacks
 * it into `<DSH_HOME>/metainfer-research-lab/perfetto-ui/<version>/`. When the
 * directory is missing the routes answer 404 and the Client falls back to
 * https://ui.perfetto.dev.
 */
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned Perfetto UI release; bump together with scripts/fetch-perfetto-ui.mjs. */
export const PERFETTO_UI_VERSION = 'v59.1';
/** Same-origin mount prefix inside the DSH web origin. */
export const PERFETTO_PREFIX = '/metainfer/perfetto';

const MIME_BY_EXT = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

const HOOK_FILE = fileURLToPath(new URL('./perfetto-hook.js', import.meta.url));
const HOOK_SRC = '/metainfer/perfetto/hook.js';

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a request path below `root` and refuse traversal. */
export function resolvePerfettoPath(root, requestPath) {
  const raw = String(requestPath ?? '').split('?')[0].split('#')[0];
  const relative = raw.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) return null;
  return resolved;
}

/**
 * Insert the MetaInfer hook into the pinned index.html. Perfetto replaces the
 * whole <body> at bootstrap, so a deferred script is enough: it runs after the
 * app boots and only observes the DOM afterwards.
 */
export function injectPerfettoHook(html) {
  if (typeof html !== 'string' || html === '') return html;
  if (html.includes(HOOK_SRC)) return html;
  // The release build appends a Google-internal userscript
  // (storage.cloud.google.com/.../amalgamated.js). On an offline/intranet Host
  // that request hangs, the document never reaches readyState=complete, and
  // Perfetto then ignores every postMessage (including PING). Neutralise that
  // one script from <head> before the bundle installs its loader.
  const guard = '<script>/* metainfer perfetto guard */'
    + '(()=>{const fix=n=>{try{if(n&&n.tagName===\'SCRIPT\'&&/storage\\.cloud\\.google\\.com|amalgamated\\.js/.test(String(n.src))){n.src=\'/metainfer/perfetto/empty.js\';}}catch(e){}};'
    + 'const ap=Element.prototype.append;Element.prototype.append=function(){for(const n of arguments)fix(n);return ap.apply(this,arguments);};'
    + 'const ac=Node.prototype.appendChild;Node.prototype.appendChild=function(n){fix(n);return ac.call(this,n);};'
    + 'const ib=Node.prototype.insertBefore;Node.prototype.insertBefore=function(n,r){fix(n);return ib.call(this,n,r);};'
    + '})();</script>';
  const hook = `<script src="${HOOK_SRC}" defer></script>`;
  let out = html;
  if (out.includes('<head>')) out = out.replace('<head>', `<head>${guard}`);
  if (out.includes('</body>')) out = out.replace('</body>', `  ${hook}\n</body>`);
  else out += hook;
  return out;
}

/**
 * Locate the unpacked UI build. Returns `null` when it has not been fetched yet.
 * @param {string} root e.g. `<DSH_HOME>/metainfer-research-lab/perfetto-ui`
 */
export async function findPerfettoUi(root) {
  if (typeof root !== 'string' || root === '') return null;
  const exact = path.join(root, PERFETTO_UI_VERSION);
  for (const candidate of [exact, root]) {
    try {
      const info = await stat(path.join(candidate, 'index.html'));
      if (info.isFile()) return candidate;
    } catch {
      // keep looking: the versioned directory may differ from the pinned name
    }
  }
  return null;
}

/**
 * Register `<PERFETTO_PREFIX>/*` on the DSH web server.
 * @param {{ register(route: object): () => void }} webServer
 * @param {{ uiRoot: string, logger?: object }} options
 */
export function registerPerfettoWeb(webServer, options = {}) {
  const uiRoot = options.uiRoot;
  const logger = options.logger ?? null;
  if (!webServer || typeof webServer.register !== 'function') return () => {};
  let resolvedRoot = null;

  const handler = (req, res) => {
    const url = String(req?.url ?? '/');
    (async () => {
      if (resolvedRoot === null) resolvedRoot = await findPerfettoUi(uiRoot);
      if (resolvedRoot === null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('perfetto ui assets are not installed');
        return;
      }
      const relativeUrl = url.startsWith(PERFETTO_PREFIX) ? url.slice(PERFETTO_PREFIX.length) : url;
      if (relativeUrl === '/hook.js' || relativeUrl === 'hook.js') {
        const body = await readFile(HOOK_FILE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (relativeUrl === '/empty.js' || relativeUrl === 'empty.js') {
        // Stand-in for the Google-internal userscript: same-origin so the DSH
        // CSP allows it and its load event fires immediately.
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end('/* metainfer noop */\n');
        return;
      }
      const cleaned = relativeUrl === '/' || relativeUrl === '' ? '/index.html' : relativeUrl;
      const file = resolvePerfettoPath(resolvedRoot, cleaned);
      if (file === null) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad path');
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      if (path.basename(file) === 'index.html') {
        const html = injectPerfettoHook(await readFile(file, 'utf8'));
        res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      res.writeHead(200, {
        'content-type': mimeOf(file),
        'cache-control': 'public, max-age=3600',
      });
      createReadStream(file).pipe(res);
    })().catch((error) => {
      if (logger !== null && typeof logger.warn === 'function') logger.warn(`perfetto assets: ${error?.message ?? error}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      try { res.end('perfetto assets error'); } catch { /* client went away */ }
    });
  };

  return webServer.register({ kind: 'prefix', path: PERFETTO_PREFIX, handler });
}

/** Exported for tests: the MIME table used by the static handler. */
export function perfettoMimeOf(file) {
  return mimeOf(file);
}

/** Exported for tests: check the pinned UI is present without throwing. */
export async function hasPerfettoUi(root) {
  try {
    await access(path.join(root, PERFETTO_UI_VERSION, 'index.html'));
    return true;
  } catch {
    return false;
  }
}
