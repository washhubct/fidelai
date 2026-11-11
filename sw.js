const CACHE_NAME = 'fidelai-card-v10';

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

// Fetch: rete prima di tutto per pagine e file del sito (così un deploy arriva
// subito a tutti), cache solo come paracadute offline. Cache-first solo per i font.
self.addEventListener('fetch', event => {
  // Solo GET: le POST verso Cloud Functions non vanno né lette né scritte in cache
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(navigate(event.request, url));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  // Tutto il resto (API, analytics): direttamente in rete, niente cache.
});

// Pagine: sempre dalla rete. La card viene salvata sotto /card.html SENZA query
// string (nell'URL c'è il token personale) e fa da fallback quando si è offline.
async function navigate(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok && url.pathname === '/card.html') {
      const cache = await caches.open(CACHE_NAME);
      cache.put('/card.html', response.clone());
    }
    return response;
  } catch {
    const isCard = url.pathname === '/card.html' || self.location.hostname.startsWith('card.');
    const cached = isCard ? await caches.match('/card.html') : null;
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

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
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
