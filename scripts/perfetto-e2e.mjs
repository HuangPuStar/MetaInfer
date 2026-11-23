#!/usr/bin/env node
/**
 * Headless-Chromium self-test for the trace tab (issue #94 follow-up).
 *
 * This one is NOT part of `npm test`: it needs Playwright's Chromium and a
 * running DSH web instance with the MetaInfer plugin. Use it against a
 * throwaway instance to verify the embedded Perfetto UI end to end.
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   DSH_E2E_BASE=http://127.0.0.1:3082 \
 *   DSH_E2E_LOG=/tmp/dsh-home/logs/web.log \
 *   DSH_E2E_PROJECT=prj-... DSH_E2E_TRACE=/abs/path/trace.json \
 *   node scripts/perfetto-e2e.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.DSH_E2E_BASE || 'http://127.0.0.1:3082';
const LOG_PATH = process.env.DSH_E2E_LOG || '';
const TRACE_PATH = process.env.DSH_E2E_TRACE || '';
const PROJECT_ID = process.env.DSH_E2E_PROJECT || '';
const SHOT = process.env.DSH_E2E_SHOT || '/tmp/perfetto-e2e.png';
const SHOT_IFRAME = process.env.DSH_E2E_SHOT_IFRAME || '/tmp/perfetto-e2e-iframe.png';

if (LOG_PATH === '' || TRACE_PATH === '' || PROJECT_ID === '') {
  console.error('set DSH_E2E_LOG, DSH_E2E_TRACE and DSH_E2E_PROJECT');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ' — ' + detail}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = readFileSync(LOG_PATH, 'utf8');
const url = (log.match(/dsh web: (http:\/\/\S+\?token=\S+)/) ?? [])[1];
if (!url) {
  console.error('no token URL in the host log');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
const page = await context.newPage();
// Record every perfetto postMessage from the very first frame, before the
// Client can post the trace.
await context.addInitScript(() => {
  window.__METAINFER_SEEN__ = [];
  window.addEventListener('message', (event) => {
    const payload = event?.data && event.data.perfetto;
    if (payload) window.__METAINFER_SEEN__.push({ t: Math.round(performance.now()), keys: Object.keys(payload), size: payload.buffer ? payload.buffer.byteLength : null, title: payload.title ?? null });
  });
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

try {
  // 1. Authenticate (the token URL sets the browser session cookie).
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  // 2. Deep link straight into the lab trace tab of the demo project.
  await page.goto(`${BASE}/?project=${PROJECT_ID}&tab=trace`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="trace-view"]', { timeout: 30000 });
  // First visit in a fresh browser profile shows the Preview Notice modal.
  const cont = page.getByRole('button', { name: /Continue/i });
  if (await cont.count()) { await cont.first().click(); await page.waitForTimeout(600); }
  check('the trace tab renders in the lab panel', true);
  const tabSelected = await page.evaluate(() => document.querySelector('#metainfer-project-tab-trace')?.getAttribute('aria-selected'));
  check('the trace tab is the active project tab', tabSelected === 'true', String(tabSelected));

  const frameBefore = page.frames().find((candidate) => candidate.url().includes('/metainfer/perfetto/'));
  const beforeInfo = frameBefore ? await frameBefore.evaluate(() => { window.__M = 1; return { origin: performance.timeOrigin, ready: document.readyState }; }) : null;
  console.log('BEFORE-OPEN:', JSON.stringify(beforeInfo));

  // 3. Open the trace by Host path through the real inputs.
  await page.locator('.rl-trace-openbar input.rl-input').fill(TRACE_PATH);
  await page.getByRole('button', { name: /^(Open|打开)$/ }).click();
  await page.waitForSelector('.rl-trace-summary', { timeout: 30000 });
  const summary = await page.locator('.rl-trace-summary').innerText();
  check('the trace summary shows the demo trace', summary.includes('torch-demo.json'), summary);
  check('the summary reports two kernels', /2\s*(kernels|个 kernel)/i.test(summary), summary);

  // 4. The embedded Perfetto loads from the same origin.
  const frame = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = page.frames().find((candidate) => candidate.url().includes('/metainfer/perfetto/'));
      if (found) return found;
      await sleep(500);
    }
    return null;
  })();
  check('the Perfetto iframe is embedded from the DSH origin', frame !== null, frame?.url() ?? 'no frame');
  check('the iframe URL is the self-hosted build', (frame?.url() ?? '').includes('/metainfer/perfetto/'), frame?.url() ?? '');

  await page.waitForFunction(
    () => {
      const text = document.querySelector('.rl-trace-stagebar .rl-hint')?.textContent ?? '';
      return /loaded|已载入/i.test(text);
    },
    null,
    { timeout: 90000 },
  ).catch(() => {});
  const status = await page.locator('.rl-trace-stagebar .rl-hint').innerText();
  check('the handshake reports the trace loaded into Perfetto', /loaded|已载入/i.test(status) && !/unavailable|不可用/i.test(status), status);

  const hookReady = frame === null ? false : await frame.evaluate(() => window.__METAINFER_PERFETTO_HOOK__ === 1);
  check('the injected Perfetto hook is active inside the iframe', hookReady === true);

  // Verify the trace actually reached Perfetto (buffer + rendered tracks).
  if (frame !== null) {
    await sleep(1500);
    const seen = await frame.evaluate(() => window.__METAINFER_SEEN__ ?? []);
    check('the iframe received a trace buffer after the handshake',
      Array.isArray(seen) && seen.some((entry) => (entry.keys ?? []).includes('buffer')), JSON.stringify(seen));
    console.log('SEEN:', JSON.stringify(seen));
    console.log('FRAMES:', JSON.stringify(page.frames().map((f) => f.url())));
    console.log('STATUS:', await page.locator('.rl-trace-stagebar .rl-hint').innerText().catch(() => '?'));
    console.log('MARKER:', await frame.evaluate(() => ({ m: window.__M ?? null, origin: performance.timeOrigin, ready: document.readyState })).catch((e) => String(e)));
    console.log('FRAME TEXT AFTER 8s:', (await frame.evaluate(() => document.body.innerText.slice(0, 800))).replace(/\n/g, ' | '));
    // Perfetto parses asynchronously after the buffer is posted; wait for tracks.
    let frameText = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      frameText = await frame.evaluate(() => document.body.innerText.slice(0, 3000));
      if (/Process 0/.test(frameText)) break;
      await sleep(500);
    }
    check('Perfetto rendered GPU/CPU process tracks for the trace',
      /Process 0/.test(frameText) && /Process 1/.test(frameText), frameText.replace(/\n/g, ' | ').slice(0, 200));
  }

  // The demo trace is 1.5 ms wide, so Perfetto needs a deep zoom; assert only
  // that the UI painted some timeline content rather than a blank page.
  if (frame !== null) {
    const text = await frame.evaluate(() => document.body.innerText.slice(0, 4000));
    check('Perfetto painted trace content (not an error page)',
      !/unrecoverable problem|Something went wrong/i.test(text), text.slice(0, 120));
    await frame.locator('body').screenshot({ path: SHOT_IFRAME }).catch(() => {});
  }

  // 5. Selection bridge: fabricate a Current Selection panel and let the hook
  //    forward it; the parent must match the kernel and open the rail.
  if (frame !== null) {
    await frame.evaluate(() => {
      const panel = document.createElement('div');
      panel.className = 'pf-details-shell';
      panel.id = 'metainfer-fake-selection';
      panel.textContent = 'Current Selection Name ampere_sgemm_128x64_nn Start 1.0 ms Duration 400 us';
      document.body.appendChild(panel);
      setTimeout(() => { panel.textContent += ' (updated)'; }, 900);
      setTimeout(() => { panel.textContent += ' .'; }, 1900);
    });
    await page.waitForSelector('[data-testid="trace-detail"]', { timeout: 15000 }).catch(() => {});
    const detail = await page.locator('[data-testid="trace-detail"]').innerText().catch(() => '');
    check('a selection inside Perfetto opens the matching kernel rail',
      detail.includes('ampere_sgemm_128x64_nn'), detail.slice(0, 200));
  }

  // 6. Rail -> Perfetto viewport jump.
  if (frame !== null) {
    const back = page.locator('[data-testid="trace-detail"] button', { hasText: '←' }).first();
    if (await back.count()) await back.click();
    await page.locator('.rl-trace-krow').first().waitFor({ timeout: 10000 });
    await page.locator('.rl-trace-krow').first().click();
    await sleep(1200);
    const jumps = await frame.evaluate(() => (window.__METAINFER_SEEN__ ?? []).filter((entry) => (entry.keys ?? []).includes('timeStart')).length);
    check('picking a kernel sends a viewport range to Perfetto', jumps > 0, String(jumps));
  }

  await page.screenshot({ path: SHOT, fullPage: false });
  check('a screenshot of the trace tab was captured', true, SHOT);
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (error) {
  console.error('E2E error:', error?.message ?? error);
  try { await page.screenshot({ path: '/root/perfetto-e2e-error.png' }); } catch { /* ignore */ }
  results.push({ name: 'E2E completed without throwing', ok: false, detail: String(error?.message ?? error) });
  console.log('FAIL E2E completed without throwing — ' + String(error?.message ?? error));
} finally {
  await browser.close();
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
