/*
 * The service worker: the app shell, offline.
 *
 * It is a classic script, not a module, on purpose. A module worker would let
 * the policy below be imported by the tests as written, but module service
 * workers are still not everywhere a classroom phone will be, and a phone that
 * refuses to register the worker is a phone that shows nothing when the Wi-Fi
 * drops - which is the one thing this file exists to prevent. So the policy is
 * plain functions, published on the global object, and the test imports this file
 * for its side effect and reads them. `apps/web-client/tests/serviceWorker.test.ts`
 * holds them down.
 *
 * The rules, in one place:
 *
 *   - a **navigation** goes to the network first and falls back to the cached
 *     shell, so a phone on the school Wi-Fi always gets the current build and a
 *     phone with no Wi-Fi still gets the app;
 *   - a **read** (`GET /api/...`) goes to the network first and falls back to the
 *     last answer, so the course list is there when the server is not;
 *   - anything else same-origin is **cache-first**: the build's assets are
 *     content-hashed, so a hit is always the right bytes;
 *   - everything else - any write, any other origin - is left alone. Nothing in
 *     this file may cache a POST, and nothing may answer for the server.
 *
 * The cache is named after a fingerprint of the served index.html rather than a
 * version typed here: the asset filenames change with every build, so the
 * fingerprint changes with every build, and a stale cache is deleted on the next
 * activation without anybody remembering to bump a number.
 */

var CACHE_PREFIX = 'lantern-'
var SHELL = ['./', './manifest.webmanifest']

/** FNV-1a, on the served shell, as a short name for this build. */
function fingerprint(text) {
  var hash = 0x811c9dc5
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * What to do with a request: 'navigation', 'network-first', 'cache-first' or
 * 'passthrough'. The origin is passed in rather than read here, so a test can
 * ask the question without a worker around it.
 */
function decide(request, origin) {
  if (request.method !== 'GET') return 'passthrough'
  var url = new URL(request.url)
  if (url.origin !== origin) return 'passthrough'
  if (request.mode === 'navigate') return 'navigation'
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network-first'
  return 'cache-first'
}

globalThis.LanternSwPolicy = {
  CACHE_PREFIX: CACHE_PREFIX,
  SHELL: SHELL,
  fingerprint: fingerprint,
  decide: decide,
}

// Everything below runs in a worker and nowhere else. The guard is what lets the
// test import this file in Node, where `self` is not a thing.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  var currentCache = CACHE_PREFIX + 'v1'

  self.addEventListener('install', function (event) {
    event.waitUntil(
      (async function () {
        // The shell is fetched, not assumed: its text is what names the cache.
        var shell = ''
        try {
          shell = await (await fetch('./', { cache: 'no-store' })).text()
        } catch (error) {
          shell = ''
        }
        currentCache = CACHE_PREFIX + fingerprint(shell)
        var cache = await caches.open(currentCache)
        await cache.addAll(SHELL).catch(function () {})
        await self.skipWaiting()
      })(),
    )
  })

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      (async function () {
        var names = await caches.keys()
        await Promise.all(
          names
            .filter(function (name) {
              return name.indexOf(CACHE_PREFIX) === 0 && name !== currentCache
            })
            .map(function (name) {
              return caches.delete(name)
            }),
        )
        await self.clients.claim()
      })(),
    )
  })

  /** Only a real answer is worth keeping: an opaque or failed one is not. */
  function remember(request, response) {
    if (!response || !response.ok) return response
    var copy = response.clone()
    caches.open(currentCache).then(function (cache) {
      cache.put(request, copy).catch(function () {})
    })
    return response
  }

  async function fromCache(request) {
    var cached = await caches.match(request)
    if (cached) return cached
    var shell = await caches.match('./')
    if (shell) return shell
    return new Response('Offline', { status: 503, statusText: 'Offline' })
  }

  async function handle(action, request) {
    if (action === 'cache-first') {
      var hit = await caches.match(request)
      if (hit) return hit
      try {
        return remember(request, await fetch(request))
      } catch (error) {
        return fromCache(request)
      }
    }
    // Navigation and API reads: fresh when the server answers, cached when it
    // does not.
    try {
      return remember(request, await fetch(request))
    } catch (error) {
      return fromCache(request)
    }
  }

  self.addEventListener('fetch', function (event) {
    var action = decide(event.request, self.location.origin)
    if (action === 'passthrough') return
    event.respondWith(handle(action, event.request))
  })
}
