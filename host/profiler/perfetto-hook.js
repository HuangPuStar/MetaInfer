/**
 * Injected into the self-hosted Perfetto UI (issue #94 follow-up).
 *
 * The Perfetto embedding API lets a host post a trace in, but it never posts the
 * user's selection back. Because we serve the pinned UI from the DSH origin, the
 * iframe is same-origin, so this hook observes Perfetto's "Current Selection"
 * details panel and forwards the selected slice text to the parent. The parent
 * maps that text back to the kernel it already parsed and opens the analysis
 * rail.
 *
 * This is deliberately defensive: if Perfetto changes its DOM, the hook simply
 * finds no panel and the parent keeps working with the kernel rail.
 */
(() => {
  if (window.parent === window) return;
  if (window.__METAINFER_PERFETTO_HOOK__) return;
  window.__METAINFER_PERFETTO_HOOK__ = 1;

  const MAX_TEXT = 4000;
  const DEBOUNCE_MS = 250;
  let lastSent = '';
  let timer = null;

  const post = (payload) => {
    try { window.parent.postMessage(payload, '*'); } catch { /* parent went away */ }
  };

  const panelText = () => {
    const panels = document.querySelectorAll('.pf-details-shell, .pf-details-box');
    for (const panel of panels) {
      const text = String(panel.innerText || '').replace(/\s+/g, ' ').trim();
      if (text !== '') return text.slice(0, MAX_TEXT);
    }
    return '';
  };

  const flush = () => {
    timer = null;
    const text = panelText();
    if (text === '' || text === lastSent) return;
    lastSent = text;
    post({ metainfer: { selection: { text, at: Date.now() } } });
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  // Perfetto boots asynchronously; observe whatever details panel exists now or
  // appears later without hammering the (large) DOM.
  const observed = new WeakSet();
  const attach = () => {
    const panels = document.querySelectorAll('.pf-details-shell, .pf-details-box');
    for (const panel of panels) {
      if (observed.has(panel)) continue;
      observed.add(panel);
      new MutationObserver(schedule).observe(panel, { subtree: true, childList: true, characterData: true });
    }
    if (panels.length === 0) {
      window.setTimeout(attach, 1000);
    } else {
      window.setTimeout(attach, 2000);
    }
  };

  post({ metainfer: { hook: 'ready', version: 1 } });
  attach();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.data === 'METAINFER-READ-SELECTION') {
      lastSent = '';
      flush();
    }
  });
})();
