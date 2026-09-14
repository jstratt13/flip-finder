const set = (id, v) => (document.getElementById(id).textContent = v);

chrome.storage.local.get(['ff_stats', 'ff_last']).then(({ ff_stats, ff_last }) => {
  const s = ff_stats ?? {};
  set('captured', s.captured ?? 0);
  set('parsed', s.parsed ?? 0);
  set('details', s.details ?? 0);
  set('sent', s.sent ?? 0);
  set('errors', s.errors ?? 0);

  if (ff_last?.site) {
    set('site', `Last capture: ${ff_last.site}`);
  }

  const el = document.getElementById('health');
  const captured = s.captured ?? 0;
  if (captured >= 20 && (s.parsed ?? 0) / captured < 0.8) {
    el.textContent = 'Parse rate is low — the site markup may have changed.';
    el.className = 'health bad';
  } else if ((s.detail_misses ?? 0) >= 3 && (s.detail_misses ?? 0) > (s.details ?? 0)) {
    // Item pages were opened but never read. Grid capture can look healthy
    // while every listing silently stays at unknown condition.
    el.textContent = 'Item details aren’t being read — the item page layout may have changed.';
    el.className = 'health bad';
  } else if (s.errors) {
    el.textContent = 'Worker rejected a batch. Check settings.';
    el.className = 'health bad';
  } else if (captured) {
    el.textContent = 'Capturing normally.';
    el.className = 'health ok';
  }
});

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
