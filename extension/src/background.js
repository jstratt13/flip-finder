// Posting from the service worker keeps the ingest key out of page context and
// sidesteps page CSP on the sites we capture from.

const DEFAULTS = { worker_url: 'http://localhost:8787', ingest_key: '' };

async function config() {
  const stored = await chrome.storage.local.get(['worker_url', 'ingest_key']);
  return { ...DEFAULTS, ...stored };
}

async function postIngest(items) {
  const { worker_url, ingest_key } = await config();
  if (!ingest_key) return { ok: false, error: 'no ingest key configured' };

  const res = await fetch(`${worker_url.replace(/\/$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': ingest_key },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) return { ok: false, error: `worker ${res.status}` };

  const body = await res.json();
  return { ok: true, ...body };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ff:ingest') return false;

  postIngest(msg.items)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keeps the message channel open for the async reply
});
