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

  const seen = new Set();
  let queue = [];
  let timer = null;
  const stats = { captured: 0, parsed: 0, failed: 0, sent: 0, errors: 0 };

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
      chrome.storage.local.set({ ff_stats: { ...stats, at: Date.now() } });
    });

    if (queue.length) schedule();
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  function push(record) {
    if (!record?.source_id) {
      stats.failed += 1;
      return;
    }
    const key = `${record.source}:${record.source_id}:${record.capture_phase}`;
    if (seen.has(key)) return;
    seen.add(key);

    stats.parsed += 1;
    queue.push(record);
    if (queue.length >= MAX_BATCH) flush();
    else schedule();
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

  function start(adapter) {
    if (adapter.isDetail()) {
      try {
        push(adapter.fromDetail());
      } catch {
        stats.failed += 1;
      }
      flush();
      return stats;
    }

    document.querySelectorAll(adapter.cardSelector).forEach((c) => {
      stats.captured += 1;
      try {
        push(adapter.fromCard(c));
      } catch {
        stats.failed += 1;
      }
    });

    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) harvest(node, adapter);
      }
    }).observe(document.body, { childList: true, subtree: true });

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
