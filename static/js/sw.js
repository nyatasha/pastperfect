/* Past Perfect service worker.
   Network-first for documents so a new daily is never served stale; cache-first
   for the shell and for images, which are content-addressed and immutable. */
var VERSION = 'pp-v2';
var SHELL = [
  '/static/css/app.css?v=2',
  '/static/js/app.js',
  '/static/js/game.js',
  '/static/js/stats.js',
  '/static/img/icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === VERSION ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') { return; }
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) { return; }
  if (url.pathname.indexOf('/api/') === 0) { return; }

  var cacheFirst = url.pathname.indexOf('/img/') === 0 ||
    url.pathname.indexOf('/static/') === 0;

  if (cacheFirst) {
    event.respondWith(
      caches.match(request).then(function (hit) {
        return hit || fetch(request).then(function (response) {
          if (response.ok) {
            var copy = response.clone();
            caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(request).then(function (response) {
      if (response.ok && request.mode === 'navigate') {
        var copy = response.clone();
        caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || caches.match('/daily');
      });
    })
  );
});
