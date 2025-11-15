// Recovery script for old PWAs that cached /src/main.tsx
// This file unregisters service workers and clears caches to fix stuck installations
// This gets copied to dist/src/main.tsx during build

(async function () {
  const status = document.createElement('div');
  status.style.cssText =
    'font-family: system-ui, sans-serif; padding: 20px; max-width: 500px; margin: 50px auto; text-align: center;';
  status.innerHTML =
    '<h2>🔧 Fixing stuck PWA...</h2><p>Cleaning up old service workers and caches...</p>';
  document.body.appendChild(status);

  let cleaned = false;

  // Unregister all service workers
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
      console.debug('Unregistered service worker:', registration.scope);
      cleaned = true;
    }
  }

  // Clear all caches
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      await caches.delete(name);
      console.debug('Deleted cache:', name);
      cleaned = true;
    }
  }

  if (cleaned) {
    status.innerHTML =
      '<h2>✅ Cleanup complete!</h2><p>Old PWA data has been cleared. Reloading in 2 seconds...</p>';
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  } else {
    status.innerHTML =
      '<h2>🤔 Nothing to clean</h2><p>No service workers or caches found. <a href="/">Go to app →</a></p>';
  }
})();
