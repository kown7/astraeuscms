(() => {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const scriptUrl = document.currentScript?.src;
  if (!scriptUrl) return;

  const workerUrl = new URL('coi-serviceworker.js', scriptUrl);
  const scope = new URL('.', scriptUrl).pathname;
  let reloading = false;
  const reloadWhenControlled = () => {
    if (reloading || !navigator.serviceWorker.controller || window.crossOriginIsolated) return;
    reloading = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', reloadWhenControlled, { once: true });
  navigator.serviceWorker.register(workerUrl, { scope })
    .then(reloadWhenControlled)
    .catch((error) => console.error('COOP/COEP service worker registration failed:', error));
})();
