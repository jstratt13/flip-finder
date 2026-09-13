(function () {
  const adapter = Object.values(globalThis.FF_ADAPTERS).find((a) => {
    try {
      return a.handles(location.href);
    } catch {
      return false;
    }
  });

  if (!adapter) return;

  const stats = globalThis.FFCapture.start(adapter);
  chrome.storage.local.set({
    ff_last: { site: adapter.name, url: location.href, at: Date.now(), stats },
  });
})();
