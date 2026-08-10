/* Issue #205: offline app shell -- state already survives offline
   (localStorage) and writes already queue (pendingWrites); the only
   missing piece was the *initial page load* surviving a dead spot. No
   reception on the 14th tee used to mean a white screen.

   v1 scope is deliberately narrow: precache just the live scorecard's
   own shell (its HTML/CSS/JS + the fonts it needs to render correctly
   offline) -- not images, the background music, or the other pages.
   Everything outside SHELL_PATHS (Supabase's own host, the brochure
   pages, images, the mp3) passes through this SW completely untouched.

   SW_VERSION is baked in by deploy.yml's cachebust sed, the exact same
   substitution every local <script src="...?v=__CACHEBUST__"> already
   gets -- that's what makes the browser's own "is there a new service
   worker" byte-diff check actually notice a new version exists at all;
   without changed bytes here, it would never re-run this file's install
   handler even though version.json changed underneath it. */
const SW_VERSION = '__CACHEBUST__';
const CACHE_NAME = 'wonga-shell-' + SW_VERSION;
const SHELL_PATHS = [
  'scorecard-live.html',
  'styles.css',
  'scorecard.css',
  'error-beacon.js',
  'theme.js',
  'scoring.js',
  'courses.js',
  'players.js',
  'qrcode-vendor.js',
  'fonts/cormorant-garamond.woff2',
  'fonts/cormorant-garamond-italic.woff2',
  'fonts/geist.woff2',
  'fonts/geist-mono.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      // Activate this SW immediately rather than waiting for every open
      // tab to close first -- the update-available toast (#196) is
      // already the "safe moment" gate (never auto-reloads, suppressed
      // mid-entry), so there's nothing extra to wait for here.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cached (and matched) by bare path, not the full request -- the shell's
// CSS/JS/HTML references carry a "?v=<sha>" cachebust query that changes
// every deploy, while CACHE_NAME itself is already versioned per-deploy
// (activate wipes every other cache name outright), so there's no risk
// of this serving stale content across versions either way. Matching on
// the bare path just means it doesn't matter whether a given request
// happened to carry this exact deploy's query string or none at all.
function shellPathFor(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  const path = url.pathname.replace(/^\//, '');
  return SHELL_PATHS.includes(path) ? path : null;
}

// Network-first with cache fallback: online scorers always get the
// freshest deploy (the existing __CACHEBUST__ + version.json
// refresh-prompt behavior, issue #196, is completely untouched by this
// SW); offline scorers get whatever shell was last successfully cached.
self.addEventListener('fetch', (event) => {
  const path = shellPathFor(event.request);
  if (!path) return; // not part of the shell -- let the browser handle it normally
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        // Only cache a genuine success. Cache.put() happily stores a 404/503
        // too -- so a GitHub Pages blip, a mid-deploy window, or a captive-
        // portal interstitial on venue wifi would otherwise become the
        // cached shell, and stay broken until the next successful fetch.
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(path, copy)).catch(() => {});
        }
        return resp;
      })
      // A cache miss resolves undefined, which respondWith() can't turn
      // into a Response -- fall back to a generic network-error response
      // instead of throwing.
      .catch(async () => (await caches.match(path)) || Response.error())
  );
});
