/* ===========================================================
   PWAfy — state.js
   Central app state, config and shared helpers.
   Built by AYOCODES
   =========================================================== */

const CONFIG = {
  SUPABASE_URL: "https://erwfyqpltzpvqerxaqpn.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_03FBVxS0kMjKtvoQgFGhHg_v3Fqf1at",
  PROXY_URL: "https://pwafy.ayocodes-pwafy.workers.dev",
  TURNSTILE_SITE_KEY: "YOUR_TURNSTILE_SITE_KEY",
  PAYSTACK_PUBLIC_KEY: "pk_live_248867e9f19f57916d0b5e4fd55ba30712aa5cbf",
  STUDIO_PRICE_NGN: 4000,
  AGENCY_PRICE_NGN: 12000,
};

const SUPABASE_CONFIGURED = CONFIG.SUPABASE_URL.startsWith("http");
const PROXY_CONFIGURED = CONFIG.PROXY_URL.startsWith("http");
const PAYSTACK_CONFIGURED = CONFIG.PAYSTACK_PUBLIC_KEY.startsWith("pk_");
const TURNSTILE_CONFIGURED =
  CONFIG.TURNSTILE_SITE_KEY !== "YOUR_TURNSTILE_SITE_KEY";

/* ---------------- App state ---------------- */
const state = {
  step: 0,
  sourceMode: "manual", // 'manual' | 'scan'
  scanUrl: "",
  scanStatus: null, // {type,message}
  name: "",
  shortName: "",
  description: "",
  startUrl: "/",
  themeColor: "#1E6E4C",
  bgColor: "#EDEFEA",
  iconDataUrl: null,
  iconImg: null,
  iconWarning: null,
  display: "standalone",
  orientation: "any",
  strategy: "stale-while-revalidate",
  phoneView: "home",
  includeSplash: true,
  includeFavicon: true,
  includeShortcuts: false,
};

const STEP_DEFS = [
  { key: "source", label: "Source" },
  { key: "identity", label: "Identity" },
  { key: "icon", label: "Icon" },
  { key: "behavior", label: "Behavior" },
  { key: "generate", label: "Generate" },
];

const DISPLAY_MODES = [
  {
    v: "standalone",
    t: "Standalone",
    d: "Looks like a native app. No browser address bar. The safest default for most sites.",
  },
  {
    v: "fullscreen",
    t: "Fullscreen",
    d: "Uses the entire screen, including the status bar area. Best for games and immersive content.",
  },
  {
    v: "minimal-ui",
    t: "Minimal UI",
    d: "Keeps a small back/reload control. A middle ground between standalone and a browser tab.",
  },
];
const ORIENTATIONS = [
  { v: "any", t: "Any" },
  { v: "portrait", t: "Portrait" },
  { v: "landscape", t: "Landscape" },
];
const STRATEGIES = [
  {
    v: "cache-first",
    t: "Cache first",
    d: "Serve from cache instantly, fall back to the network only when nothing is cached. Fastest, best for sites that change rarely.",
    code: "cache.match(req) || fetch(req)",
  },
  {
    v: "network-first",
    t: "Network first",
    d: "Always try the network first, fall back to cache when offline. Best when content changes often and freshness matters most.",
    code: "fetch(req).catch(() => cache.match(req))",
  },
  {
    v: "stale-while-revalidate",
    t: "Stale-while-revalidate",
    d: "Serve the cached copy immediately, then quietly update the cache in the background. A good default for most sites.",
    code: "cache.match(req); fetch(req).then(update)",
  },
];

// iOS splash screens need exact per-device pixel sizes (portrait, @2x/@3x).
// This is the set that covers current iPhones/iPads without bloating the zip.
const IOS_SPLASH_SIZES = [
  { w: 1290, h: 2796, label: "iPhone 15 Pro Max / 14 Pro Max" },
  { w: 1179, h: 2556, label: "iPhone 15 / 14 Pro" },
  { w: 1170, h: 2532, label: "iPhone 13 / 12" },
  { w: 1125, h: 2436, label: "iPhone X / XS / 11 Pro" },
  { w: 828, h: 1792, label: "iPhone 11 / XR" },
  { w: 1668, h: 2388, label: 'iPad Pro 11"' },
];

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

/* ---------------- Small shared helpers ---------------- */
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function normalizeHex(v) {
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
  return null;
}

function slugShortName(name) {
  return name.trim().slice(0, 12);
}

function contrastColor(hex) {
  if (!/^#([0-9a-f]{6})$/i.test(hex)) return "#141C18";
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#141C18" : "#EDEFEA";
}

function tick() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
}
