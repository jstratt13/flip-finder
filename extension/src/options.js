const fields = ['worker_url', 'ingest_key'];

chrome.storage.local.get(fields).then((stored) => {
  for (const f of fields) document.getElementById(f).value = stored[f] ?? '';
});

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const f of fields) values[f] = document.getElementById(f).value.trim();
  await chrome.storage.local.set(values);

  const status = document.getElementById('status');
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 1800);
});
