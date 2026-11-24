(() => {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const scriptUrl = document.currentScript?.src;
  if (!scriptUrl) return;

  const workerUrl = new URL('coi-serviceworker.js', scriptUrl);
  const scope = new URL('.', scriptUrl).pathname;
  const reloadKey = `astraeuscms-coi-reload:${scope}`;
  let registration;
  let reloading = false;

  const reloadIfNeeded = () => {
    if (window.crossOriginIsolated) {
      try { sessionStorage.removeItem(reloadKey); } catch {}
      return;
    }
    if (reloading || (!navigator.serviceWorker.controller && !registration?.active)) return;
    try {
      if (sessionStorage.getItem(reloadKey) === '1') {
        console.error('COOP/COEP service worker did not isolate the admin page after reload.');
        return;
      }
      sessionStorage.setItem(reloadKey, '1');
    } catch (error) {
      console.error('Unable to prepare the COOP/COEP reload:', error);
      return;
    }
    reloading = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', reloadIfNeeded, { once: true });
  navigator.serviceWorker.register(workerUrl, { scope })
    .then((activeRegistration) => {
      registration = activeRegistration;
      reloadIfNeeded();
    })
    .catch((error) => console.error('COOP/COEP service worker registration failed:', error));
})();
