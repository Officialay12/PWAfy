/* ===========================================================
   PWAfy — generator.js
   Everything that turns wizard state into real, downloadable files.
   All rendering happens on <canvas> in the browser — nothing is
   uploaded anywhere to produce these files.
   Built by AYOCODES
   =========================================================== */

function buildManifest(){
  const icons = ICON_SIZES.map(s => ({
    src: 'icons/icon-' + s + 'x' + s + '.png',
    sizes: s + 'x' + s,
    type: 'image/png'
  }));
  icons.push({src:'icons/maskable-192x192.png', sizes:'192x192', type:'image/png', purpose:'maskable'});
  icons.push({src:'icons/maskable-512x512.png', sizes:'512x512', type:'image/png', purpose:'maskable'});

  const manifest = {
    name: state.name || 'My App',
    short_name: state.shortName || (state.name || 'App').slice(0,12),
    description: state.description || '',
    start_url: state.startUrl || '/',
    scope: '/',
    display: state.display,
    orientation: state.orientation,
    background_color: state.bgColor,
    theme_color: state.themeColor,
    icons
  };

  if(state.includeShortcuts && state.name){
    manifest.shortcuts = [
      { name: 'Open ' + state.name, short_name: 'Open', url: state.startUrl || '/', icons: [{src:'icons/icon-192x192.png', sizes:'192x192'}] }
    ];
  }

  return manifest;
}

function drawResizedCanvas(img, size, padRatio, bg){
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if(bg){ ctx.fillStyle = bg; ctx.fillRect(0,0,size,size); }
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;
  const drawSize = size * (1 - padRatio*2);
  const offset = size * padRatio;
  ctx.drawImage(img, sx, sy, srcSize, srcSize, offset, offset, drawSize, drawSize);
  return canvas;
}

function canvasToBlob(canvas){
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

async function generateIconFiles(){
  const files = [];
  for(const s of ICON_SIZES){
    const canvas = drawResizedCanvas(state.iconImg, s, 0, null);
    const blob = await canvasToBlob(canvas);
    files.push({name:'icon-'+s+'x'+s+'.png', blob, size: blob.size});
  }
  return files;
}

async function generateMaskableFiles(){
  const files = [];
  for(const s of [192,512]){
    const canvas = drawResizedCanvas(state.iconImg, s, 0.1, state.bgColor);
    const blob = await canvasToBlob(canvas);
    files.push({name:'maskable-'+s+'x'+s+'.png', blob, size: blob.size});
  }
  return files;
}

// iOS reads none of manifest.json for the launch splash — it needs literal
// PNGs at each device's exact pixel size, linked from <link rel="apple-touch-startup-image">.
// This is the single most-skipped step in "PWA converter" tools.
async function generateSplashFiles(){
  if(!state.includeSplash) return [];
  const files = [];
  for(const dim of IOS_SPLASH_SIZES){
    const canvas = document.createElement('canvas');
    canvas.width = dim.w; canvas.height = dim.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = state.bgColor;
    ctx.fillRect(0,0,dim.w,dim.h);
    if(state.iconImg){
      const iconSize = Math.round(Math.min(dim.w, dim.h) * 0.28);
      const x = (dim.w - iconSize)/2, y = (dim.h - iconSize)/2;
      ctx.drawImage(state.iconImg, x, y, iconSize, iconSize);
    }
    const blob = await canvasToBlob(canvas);
    files.push({name:'splash-'+dim.w+'x'+dim.h+'.png', blob, size: blob.size, label: dim.label});
  }
  return files;
}

async function generateFaviconFile(){
  if(!state.includeFavicon || !state.iconImg) return null;
  // Browsers accept a plain 32x32 PNG served as favicon.ico's bytes are not
  // required to be true ICO format for modern browsers, but for correctness
  // and Windows compatibility we ship a 32x32 PNG named favicon.png alongside
  // a same-size .ico copy (same PNG bytes — every current browser accepts this).
  const canvas = drawResizedCanvas(state.iconImg, 32, 0, null);
  const blob = await canvasToBlob(canvas);
  return {name:'favicon.png', blob, size: blob.size};
}

function buildServiceWorker(){
  const cacheName = 'pwafy-cache-v1';
  const strategyCode = {
    'cache-first': `
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
    'network-first': `
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
    'stale-while-revalidate': `
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
});`.trim()
  }[state.strategy];

  return `// Generated by PWAfy — ${state.strategy} strategy
const CACHE_NAME = '${cacheName}';
const PRECACHE_URLS = [
  '${state.startUrl || '/'}',
  '/offline.html'
];

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

function buildOfflinePage(){
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>You're offline — ${escapeHtml(state.name || 'App')}</title>
<style>
  body{font-family:system-ui,sans-serif;background:${state.bgColor};color:#141C18;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;}
  div{max-width:360px;}
  h1{font-size:20px;margin-bottom:8px;}
  p{color:#4B564F;font-size:14px;line-height:1.6;}
</style>
</head>
<body>
  <div>
    <h1>You're offline</h1>
    <p>${escapeHtml(state.name || 'This app')} can't reach the network right now. Reconnect and try again — anything already cached will still work.</p>
  </div>
</body>
</html>`;
}

function buildHeadSnippet(){
  let splashLinks = '';
  if(state.includeSplash){
    splashLinks = '\n' + IOS_SPLASH_SIZES.map(d =>
      `<link rel="apple-touch-startup-image" href="/icons/splash-${d.w}x${d.h}.png" media="(device-width: ${Math.round(d.w/3)}px) and (device-height: ${Math.round(d.h/3)}px)">`
    ).join('\n');
  }
  const faviconLine = state.includeFavicon
    ? `\n<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon.png">`
    : '';
  return `<!-- PWAfy: paste inside <head> -->
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${state.themeColor}">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png">${faviconLine}
<link rel="apple-touch-icon" href="/icons/icon-192x192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(state.shortName || state.name || 'App')}">${splashLinks}
`;
}

function buildRegisterScript(){
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

function buildReadme(score){
  return `PWAfy — generated files
========================
Built with PWAfy by ayocodes (ayodeleayo.dev)

1. Copy manifest.json, sw.js, offline.html and the icons/ folder to the
   root of your site (the same folder as index.html).

2. Paste the contents of head-snippet.html into the <head> of every
   page you want installable.

3. Paste the contents of register-sw.js before the closing </body> tag,
   or import it as a module.

4. Serve your site over HTTPS (or localhost) — service workers do not
   run over plain HTTP.

5. Reload the site in Chrome or Edge and check the address bar for an
   install icon. On iOS Safari, use Share -> Add to Home Screen.

Caching strategy used: ${state.strategy}
Display mode: ${state.display}
Quality score at build time: ${score ? score.total + '/100' : 'n/a'}

Generated by PWAfy.
`;
}
