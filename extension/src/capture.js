// Capture chassis, shared by every adapter.
//
// Cards are read as they mount rather than queried in bulk later: feeds that
// virtualise (Facebook) destroy nodes once scrolled past, so anything not taken
// at mount time is gone.
globalThis.FFCapture = (function () {
  // The worker chunks its lookups, so this isn't load-bearing, but it keeps
  // each ingest under D1's 100-parameter statement limit anyway.
  const MAX_BATCH = 90;
  const FLUSH_MS = 4000;

  // Single-page sites change the URL without reloading, so the content script
  // never runs again. Polling the URL is the reliable signal: content scripts
  // live in an isolated world, so patching history.pushState here would never
  // see the page's own calls.
  const URL_POLL_MS = 500;

  // An item opened in-page renders after the URL changes, and for a moment can
  // still show the previous item. A detail is only recorded once two reads in a
  // row agree; if that never happens, nothing is recorded.
  const DETAIL_POLL_MS = 400;
  const DETAIL_TIMEOUT_MS = 10000;

  const seen = new Set();
  let queue = [];
  let timer = null;
  let lastDetail = null;
  const stats = { captured: 0, parsed: 0, failed: 0, sent: 0, errors: 0, details: 0, detail_misses: 0 };

  const persist = () => chrome.storage.local.set({ ff_stats: { ...stats, at: Date.now() } });

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!queue.length) return;

    const items = queue.splice(0, MAX_BATCH);
    chrome.runtime.sendMessage({ type: 'ff:ingest', items }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        stats.errors += 1;
      } else {
        stats.sent += res.accepted ?? items.length;
      }
      persist();
    });

    if (queue.length) schedule();
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  function push(record) {
    if (!record?.source_id) {
      stats.failed += 1;
      return false;
    }
    const key = `${record.source}:${record.source_id}:${record.capture_phase}`;
    if (seen.has(key)) return false;
    seen.add(key);

    stats.parsed += 1;
    queue.push(record);
    if (queue.length >= MAX_BATCH) flush();
    else schedule();
    return true;
  }

  function harvest(node, adapter) {
    if (node.nodeType !== 1) return;
    const cards = node.matches?.(adapter.cardSelector)
      ? [node]
      : [...node.querySelectorAll(adapter.cardSelector)];
    for (const card of cards) {
      stats.captured += 1;
      try {
        push(adapter.fromCard(card));
      } catch {
        stats.failed += 1;
      }
    }
  }

  const inScope = (adapter) => (adapter.inScope ? adapter.inScope(location) : true);

  // What a detail says, without the id. The id comes from the URL, which
  // changes before the content does, so matching on content is what catches a
  // stale render of the previous item.
  const contentOf = (r) => JSON.stringify([r.title, r.price, r.description, r.condition_raw]);

  function captureDetailWhenSettled(adapter) {
    const url = location.href;
    let prev = null;
    let waited = 0;

    const tick = () => {
      // Navigated away before it settled; the new URL gets its own pass.
      if (location.href !== url) return;

      let rec = null;
      try {
        rec = adapter.fromDetail();
      } catch {
        rec = null;
      }

      const content = rec ? contentOf(rec) : null;
      const stale = rec && lastDetail && lastDetail.id !== rec.source_id && lastDetail.content === content;

      if (rec && !stale && content === prev) {
        lastDetail = { id: rec.source_id, content };
        if (push(rec)) stats.details += 1;
        flush();
        return;
      }

      prev = stale ? null : content;
      waited += DETAIL_POLL_MS;
      if (waited >= DETAIL_TIMEOUT_MS) {
        stats.detail_misses += 1;
        persist();
        return;
      }
      setTimeout(tick, DETAIL_POLL_MS);
    };

    tick();
  }

  function sweep(adapter) {
    document.querySelectorAll(adapter.cardSelector).forEach((c) => {
      stats.captured += 1;
      try {
        push(adapter.fromCard(c));
      } catch {
        stats.failed += 1;
      }
    });
  }

  function start(adapter) {
    if (!adapter.spa) {
      // Every navigation is a page load, so one decision at load is enough.
      if (adapter.isDetail()) {
        try {
          push(adapter.fromDetail());
        } catch {
          stats.failed += 1;
        }
        flush();
        return stats;
      }

      sweep(adapter);
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) harvest(node, adapter);
        }
      }).observe(document.body, { childList: true, subtree: true });

      window.addEventListener('pagehide', flush);
      return stats;
    }

    let lastUrl = null;
    const onUrl = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (!inScope(adapter)) return;
      if (adapter.isDetail()) captureDetailWhenSettled(adapter);
      sweep(adapter);
    };

    new MutationObserver((mutations) => {
      if (!inScope(adapter)) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) harvest(node, adapter);
      }
    }).observe(document.body, { childList: true, subtree: true });

    onUrl();
    setInterval(onUrl, URL_POLL_MS);
    window.addEventListener('pagehide', flush);
    return stats;
  }

  // Selector rot shows up as a collapsing parse rate long before it shows up
  // as missing listings in the dashboard.
  function health() {
    if (stats.captured < 20) return 'unknown';
    return stats.parsed / stats.captured < 0.8 ? 'degraded' : 'ok';
  }

  return { start, flush, stats, health };
})();

// Same pattern as adapters.js: Chrome ignores this, the test suite requires it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.FFCapture;
}
