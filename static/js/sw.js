/* Past Perfect service worker.
   Network-first for documents so a new daily is never served stale. Images are
   content-addressed and immutable, so they are served straight from the cache
   and never looked at again. The shell -- the CSS and the scripts -- is not
   immutable: `/static/js/game.js` keeps its name from one deploy to the next,
   so a plain cache-first rule pins whatever copy a browser saw first and no
   later fix ever reaches it. That is not hypothetical: the fix that stopped
   the reveal links leaking a referrer shipped, and browsers holding the old
   game.js carried on sending one and carried on being blocked by the museum.
   So the shell is stale-while-revalidate: fast from the cache, and refreshed
   in the background every time, which repairs itself by the next load. */
var VERSION = 'pp-v6';
var SHELL = [
  '/static/css/app.css?v=3',
  '/static/js/app.js',
  '/static/js/share.js',
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

  function store(response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }

  /* Immutable: the key in the path is a hash of the image. */
  if (url.pathname.indexOf('/img/') === 0) {
    event.respondWith(
      caches.match(request).then(function (hit) {
        return hit || fetch(request).then(store);
      })
    );
    return;
  }

  /* Mutable, under a stable name: answer from the cache if we have it, but
     always ask the network too and keep what comes back for next time. */
  if (url.pathname.indexOf('/static/') === 0) {
    event.respondWith(
      caches.match(request).then(function (hit) {
        /* `cache: 'reload'` skips the browser's own HTTP cache, which holds
           these for an hour and would otherwise hand back the same stale copy
           we are trying to replace. */
        var fresh = fetch(new Request(request.url, { cache: 'reload', credentials: 'same-origin' }))
          .then(store).catch(function () { return hit; });
        return hit || fresh;
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
