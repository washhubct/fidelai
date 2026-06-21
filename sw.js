const CACHE_NAME = 'fidelai-card-v7';

const STATIC_ASSETS = [
  '/card.html',
  '/css/style.css',
  '/manifest.json',
  '/manifest-washhub.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

// Install: pre-cache essential static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static assets, network-first for API calls
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for Firestore / API requests
  if (url.hostname.includes('googleapis.com') && !url.pathname.includes('/css')) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (url.hostname.includes('firestore') || url.hostname.includes('firebaseio')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for everything else (HTML, CSS, fonts, scripts)
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.mode === 'navigate') {
      return caches.match('/card.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
