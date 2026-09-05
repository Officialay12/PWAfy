/* ===========================================================
   PWAfy, generator.js
   Everything that turns wizard state into real, downloadable files.
   All rendering happens on <canvas> in the browser, nothing is
   uploaded anywhere to produce these files.
   Built by AYOCODES
   =========================================================== */

function buildManifest() {
  const icons = ICON_SIZES.map((s) => ({
    src: "icons/icon-" + s + "x" + s + ".png",
    sizes: s + "x" + s,
    type: "image/png",
  }));
  icons.push({
    src: "icons/maskable-192x192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "maskable",
  });
  icons.push({
    src: "icons/maskable-512x512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  });

  const manifest = {
    name: state.name || "My App",
    short_name: state.shortName || (state.name || "App").slice(0, 12),
    description: state.description || "",
    start_url: state.startUrl || "/",
    scope: "/",
    display: state.display,
    orientation: state.orientation,
    background_color: normalizeHex(state.bgColor) || "#EDEFEA",
    theme_color: normalizeHex(state.themeColor) || "#000000",
    icons,
  };

  if (state.includeShortcuts && state.name) {
    manifest.shortcuts = [
      {
        name: "Open " + state.name,
        short_name: "Open",
        url: state.startUrl || "/",
        icons: [{ src: "icons/icon-192x192.png", sizes: "192x192" }],
      },
    ];
  }

  if (state.screenshots && state.screenshots.length) {
    manifest.screenshots = state.screenshots.map((s, i) => ({
      src: "screenshots/screenshot-" + (i + 1) + ".png",
      sizes: s.width + "x" + s.height,
      type: "image/png",
      form_factor: s.formFactor,
    }));
  }

  return manifest;
}

function drawResizedCanvas(img, size, padRatio, bg) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;
  const drawSize = size * (1 - padRatio * 2);
  const offset = size * padRatio;
  ctx.drawImage(
    img,
    sx,
    sy,
    srcSize,
    srcSize,
    offset,
    offset,
    drawSize,
    drawSize,
  );
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}

async function generateIconFiles() {
  const files = [];
  for (const s of ICON_SIZES) {
    const canvas = drawResizedCanvas(state.iconImg, s, 0, null);
    const blob = await canvasToBlob(canvas);
    files.push({ name: "icon-" + s + "x" + s + ".png", blob, size: blob.size });
  }
  return files;
}

async function generateMaskableFiles() {
  const files = [];
  for (const s of [192, 512]) {
    const canvas = drawResizedCanvas(state.iconImg, s, 0.1, state.bgColor);
    const blob = await canvasToBlob(canvas);
    files.push({
      name: "maskable-" + s + "x" + s + ".png",
      blob,
      size: blob.size,
    });
  }
  return files;
}

// iOS reads none of manifest.json for the launch splash, it needs literal
// PNGs at each device's exact pixel size, linked from <link rel="apple-touch-startup-image">.
// This is the single most-skipped step in "PWA converter" tools.
async function generateSplashFiles() {
  if (!state.includeSplash) return [];
  const files = [];
  for (const dim of IOS_SPLASH_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = dim.w;
    canvas.height = dim.h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = state.bgColor;
    ctx.fillRect(0, 0, dim.w, dim.h);
    if (state.iconImg) {
      const iconSize = Math.round(Math.min(dim.w, dim.h) * 0.28);
      const x = (dim.w - iconSize) / 2,
        y = (dim.h - iconSize) / 2;
      ctx.drawImage(state.iconImg, x, y, iconSize, iconSize);
    }
    const blob = await canvasToBlob(canvas);
    files.push({
      name: "splash-" + dim.w + "x" + dim.h + ".png",
      blob,
      size: blob.size,
      label: dim.label,
    });
  }
  return files;
}

async function generateFaviconFile() {
  if (!state.includeFavicon || !state.iconImg) return null;
  // Browsers accept a plain 32x32 PNG served as favicon.ico's bytes are not
  // required to be true ICO format for modern browsers, but for correctness
  // and Windows compatibility we ship a 32x32 PNG named favicon.png alongside
  // a same-size .ico copy (same PNG bytes, every current browser accepts this).
  const canvas = drawResizedCanvas(state.iconImg, 32, 0, null);
  const blob = await canvasToBlob(canvas);
  return { name: "favicon.png", blob, size: blob.size };
}

// Screenshots power the richer install UI Chrome/Edge show on desktop and
// Android, a manifest with no screenshots gets the plain install prompt.
// Passed through at a capped max dimension rather than a fixed size list
// (unlike icons, screenshots aren't meant to be uniform squares). The cap
// lives in state.js (SCREENSHOT_MAX_DIM) so wizard.js can declare the same
// final dimensions in the manifest that this function actually produces.
async function generateScreenshotFiles() {
  if (!state.screenshots || !state.screenshots.length) return [];
  const files = [];
  for (let i = 0; i < state.screenshots.length; i++) {
    const s = state.screenshots[i];
    const img = s.img;
    const scale = Math.min(
      1,
      SCREENSHOT_MAX_DIM / Math.max(img.width, img.height),
    );
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas);
    files.push({
      name: "screenshot-" + (i + 1) + ".png",
      blob,
      size: blob.size,
    });
  }
  return files;
}

function buildServiceWorker() {
  // A fresh cache name every time this is generated, not a hardcoded literal.
  // The activate handler below only cleans up caches that don't match
  // CACHE_NAME, with a constant name across every build, that cleanup
  // never actually fires, and a cache-first strategy would keep serving a
  // visitor's *first-ever* cached version indefinitely, even after the
  // site changes and this file is regenerated and redeployed. A per-build
  // name means every regeneration is itself a cache-bust.
  const cacheName = "pwafy-cache-" + Date.now().toString(36);
  const strategyCode = {
    "cache-first": `
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match('/offline.html'));
    })
  );
});`.trim(),
    "network-first": `
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('/offline.html')))
  );
});`.trim(),
    "stale-while-revalidate": `
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request)
          .then(response => {
            cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached || caches.match('/offline.html'));
        return cached || fetchPromise;
      })
    )
  );
});`.trim(),
  }[state.strategy];

  return `// Generated by PWAfy, ${state.strategy} strategy
const CACHE_NAME = '${cacheName}';
const PRECACHE_URLS = ${JSON.stringify([state.startUrl || "/", "/offline.html"])};

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

${strategyCode}
`;
}

function buildOfflinePage() {
  const bg = normalizeHex(state.bgColor) || "#EDEFEA";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>You're offline, ${escapeHtml(state.name || "App")}</title>
<style>
  body{font-family:system-ui,sans-serif;background:${bg};color:#141C18;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;}
  div{max-width:360px;}
  h1{font-size:20px;margin-bottom:8px;}
  p{color:#4B564F;font-size:14px;line-height:1.6;}
</style>
</head>
<body>
  <div>
    <h1>You're offline</h1>
    <p>${escapeHtml(state.name || "This app")} can't reach the network right now. Reconnect and try again, anything already cached will still work.</p>
  </div>
</body>
</html>`;
}

function buildHeadSnippet() {
  const theme = normalizeHex(state.themeColor) || "#000000";
  let splashLinks = "";
  if (state.includeSplash) {
    splashLinks =
      "\n" +
      IOS_SPLASH_SIZES.map(
        (d) =>
          `<link rel="apple-touch-startup-image" href="/icons/splash-${d.w}x${d.h}.png" media="(device-width: ${Math.round(d.w / 3)}px) and (device-height: ${Math.round(d.h / 3)}px)">`,
      ).join("\n");
  }
  const faviconLine = state.includeFavicon
    ? `\n<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon.png">`
    : "";
  return `<!-- PWAfy: paste inside <head> -->
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${theme}">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png">${faviconLine}
<link rel="apple-touch-icon" href="/icons/icon-192x192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(state.shortName || state.name || "App")}">${splashLinks}
`;
}

function buildRegisterScript() {
  return `// PWAfy: paste before </body>, or import as a module
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('PWAfy: service worker registered', reg.scope))
      .catch(err => console.error('PWAfy: service worker registration failed', err));
  });
}
`;
}

function bufToBase64Url(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Generates a real VAPID keypair (P-256 ECDSA) client-side via Web Crypto, // nothing is sent anywhere to produce these, same as every other file this
// tool generates. Public key format matches what PushManager.subscribe()
// and every VAPID-aware push library (web-push, etc.) expect.
async function generateVapidKeys() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKey: bufToBase64Url(publicRaw),
    privateKey: privateJwk.d, // raw 32-byte scalar, already base64url per JWK
  };
}

function buildPushSwSnippet() {
  return `// PWAfy: append to the end of sw.js to handle incoming pushes.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* not JSON */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Update', {
      body: data.body || '',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(targetUrl));
});
`;
}

function buildPushSubscribeSnippet(publicKey) {
  return `// PWAfy: run this from a user gesture (e.g. a "Enable notifications"
// button click), browsers block silent permission requests on load.
async function subscribeToPush() {
  const reg = await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: '${publicKey}'
  });
  // Send \`subscription\` (via subscription.toJSON()) to your own server to
  // store it, that's what your backend uses later to send a push with the
  // matching private key. PWAfy doesn't run that server for you.
  return subscription;
}
`;
}

function buildPushPrivateReadme(keys) {
  return `PWAfy, Web Push keys (KEEP THIS FOLDER PRIVATE)
==================================================
DO NOT deploy this "push/" folder to your public web server, and do not
commit vapid-keys.json to a public repository. The private key in it can
be used to send push notifications to every subscriber on your behalf, treat it exactly like an API secret.

Where it goes instead: store PWAFY_VAPID_PRIVATE_KEY as an environment
variable on whatever server sends your push notifications (it's the
"private key" a library like web-push needs). The public key is safe to
ship client-side, it's already embedded in push-subscribe-snippet.js.

Public key:  ${keys.publicKey}
Private key: ${keys.privateKey}

Files in this folder:
- push-sw-snippet.js       -> append to your public sw.js (this one IS safe to deploy)
- push-subscribe-snippet.js -> client-side code to request permission + subscribe (safe to deploy, already has the public key baked in)
- vapid-keys.json          -> both keys together, for your own records (KEEP PRIVATE)
`;
}

function buildReadme(score, options) {
  const opts = options || {};
  const attribution =
    opts.attribution || "Built with PWAfy by ayocodes (ayodeleayo.dev)";
  const screenshotLine =
    state.screenshots && state.screenshots.length
      ? "\n7. Copy the screenshots/ folder alongside icons/ as well, it powers\n   the richer install prompt some browsers show.\n"
      : "";
  const pushLine = opts.includePush
    ? "\n8. Web Push files are in the separate push/ folder. Read push/README-KEEP-PRIVATE.txt\n   before deploying anything from it, the private key must never go on\n   your public web server.\n"
    : "";
  return `PWAfy, generated files
========================
${attribution}

1. Copy manifest.json, sw.js, offline.html and the icons/ folder to the
   root of your site (the same folder as index.html).

2. Paste the contents of head-snippet.html into the <head> of every
   page you want installable.

3. Paste the contents of register-sw.js before the closing </body> tag,
   or import it as a module.

4. Serve your site over HTTPS (or localhost), service workers do not
   run over plain HTTP.

5. Reload the site in Chrome or Edge and check the address bar for an
   install icon. On iOS Safari, use Share -> Add to Home Screen.

6. Whenever you make changes to your live site that you want visitors'
   cached copies to pick up, regenerate this ZIP and redeploy the new
   sw.js, each build gets a fresh internal cache version, which is what
   actually clears out the old cached files on visitors' devices.${screenshotLine}${pushLine}
Caching strategy used: ${state.strategy}
Display mode: ${state.display}
Quality score at build time: ${score ? score.total + "/100" : "n/a"}

${opts.attribution ? attribution : "Generated by PWAfy."}
`;
}
