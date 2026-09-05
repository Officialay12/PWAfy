const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 2_000_000; // 2MB cap so a huge page can't tie up the worker
const SCAN_CACHE_TTL_SECONDS = 60 * 60 * 6; // 6 hours, cuts repeat-scan load a lot
const RATE_LIMIT_PER_MINUTE = 12; // per client IP, on the scan endpoint only
const TRANSFER_RATE_LIMIT_PER_HOUR = 6; // per client IP, on account-creation only
const MAGIC_LINK_RATE_LIMIT_PER_HOUR = 5; // per client IP, on sign-in requests
const PLAN_DURATION_DAYS = 30; // how long a paid plan lasts after a successful charge
const ASSISTANT_RATE_LIMIT_PER_MINUTE = 8; // per client IP, on the PWAfy AI endpoint
const ASSISTANT_MESSAGE_MAX_CHARS = 800;
const ASSISTANT_HISTORY_MAX_TURNS = 8;
// Groq deprecated llama-3.3-70b-versatile (decommissioned 2026-08-16).
// openai/gpt-oss-120b is Groq's own recommended replacement and uses the
// same OpenAI-style chat completions request shape, so nothing else below
// needs to change. If Groq deprecates this one too, only this line and
// nothing else should need to change.
const ASSISTANT_MODEL = "openai/gpt-oss-120b";

// Everything the assistant is allowed to know about PWAfy, kept in sync
// with the copy on the site itself (index.html / terms.html). Never lets
// the model reveal what actually powers it underneath, every credit the
// user sees is PWAfy / ayocodes only.
const ASSISTANT_SYSTEM_PROMPT = `You are PWAfy AI, the built-in assistant on PWAfy, a browser-based tool that turns any website into an installable Progressive Web App.

What PWAfy does: from a URL scan or manual details, it generates a spec-correct manifest.json, a full icon set (72 to 512px), iOS splash screens for common device sizes, a working service worker with a chosen caching strategy (cache-first, network-first, or stale-while-revalidate), and a plain-language installability quality score. Everything is generated client-side in the browser, nothing is hosted or rehosted, the user copies the output onto their own server.

Scanning a URL: PWAfy's server proxies the request so it can read response headers, only reads the page's public title, description, theme color, and icon link, and does not store the page content beyond a short cache used to speed up repeat scans of the same URL.

Accounts: optional, passwordless (a one-time email link), used to save brand presets, build history, and to unlock paid plans. No password is ever stored.

Plans: Free (one build per account or browser session, full manifest and icon set, one caching strategy, one saved preset, quality score). Studio (unlimited builds and re-generation, up to 10 saved presets, app shortcuts and screenshots for a richer install prompt). Agency (everything in Studio, unlimited presets, Web Push boilerplate add-on, fully white-labelled output with no PWAfy branding, a shared team workspace for up to 5 seats). Studio and Agency are billed monthly in Nigerian naira, payable by card or direct bank transfer through Paystack, each paid period runs 30 days from a successful payment, cancelling returns the account to Free immediately with no partial refund for the remaining days. Prices shown in other currencies are an approximate guide only, card charges always settle in naira.

Support: users can cancel a paid plan any time from the account menu. Payment issues should be raised with the account email and payment reference.

Tone: friendly, concise, plain language, sentence case, no corporate filler. If you don't know something specific about a user's own account or a live payment status, say so plainly and suggest checking the account menu or contacting support, don't guess.

Never mention or imply which company or model actually powers you behind the scenes. If asked who made you or what you run on, say you're PWAfy AI, built by ayocodes for PWAfy. Never say you are Groq, Llama, OpenAI, or any other provider or model name, and don't discuss your own architecture.`;

// SOURCE OF TRUTH for plan prices. Never trust a client-supplied amount, // the frontend's CONFIG.STUDIO_PRICE_NGN / AGENCY_PRICE_NGN are for display
// only. Every upgrade path below re-derives the required amount from here
// and refuses to upgrade a plan for less.
const PLAN_PRICES_NGN = {
  studio: 4000,
  agency: 12000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ============================================================
   CORS
   Only origins listed in env.ALLOWED_ORIGINS (comma-separated) get a
   matching Access-Control-Allow-Origin back. Anything else gets no
   usable CORS headers, so a browser request from an unlisted origin
   is refused by the browser itself. Falls back to localhost only if
   the var isn't set, so local dev keeps working out of the box.
   ============================================================ */

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowList = (env.ALLOWED_ORIGINS || "https://pwafy.pages.dev")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (allowList.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// Applied to every response this Worker sends. This Worker only ever
// serves JSON to fetch()/XHR callers (never HTML), so a maximally strict
// CSP is safe here, there is no page context for it to break.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, ...SECURITY_HEADERS },
  });
}

/* ============================================================
   1. URL SCAN (with KV cache, rate limiting, and optional Turnstile)
   ============================================================ */

function extractMeta(html, baseUrl) {
  const result = {
    title: null,
    description: null,
    themeColor: null,
    iconUrl: null,
  };
  let iconHref = null;

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(text) {
        result.title = (result.title || "") + text.text;
      },
    })
    .on('meta[name="description" i]', {
      element(el) {
        if (!result.description)
          result.description = el.getAttribute("content");
      },
    })
    .on('meta[name="theme-color" i]', {
      element(el) {
        if (!result.themeColor) result.themeColor = el.getAttribute("content");
      },
    })
    .on('link[rel~="icon" i]', {
      element(el) {
        if (!iconHref) iconHref = el.getAttribute("href");
      },
    });

  return rewriter
    .transform(new Response(html))
    .text()
    .then(() => {
      if (result.title) result.title = result.title.trim();
      if (iconHref) {
        try {
          result.iconUrl = new URL(iconHref, baseUrl).href;
        } catch (e) {
          /* ignore malformed href */
        }
      }
      return result;
    });
}

// Generic fixed-window limiter. `windowSeconds` also buckets the KV key, so
// different endpoints (scan: 1-minute windows, transfer: 1-hour windows)
// don't collide or share a budget.
async function checkRateLimit(
  env,
  bucketKey,
  limit = RATE_LIMIT_PER_MINUTE,
  windowSeconds = 60,
) {
  if (!env.RATE_LIMIT) return true; // if the KV isn't bound yet, don't block, fail open
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = "rl:" + bucketKey + ":" + window;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: windowSeconds + 30,
  });
  return true;
}

// Verifies a Cloudflare Turnstile token server-side. Returns true (and skips
// the check entirely) if no TURNSTILE_SECRET_KEY is configured, matching the
// frontend's TURNSTILE_CONFIGURED gate, Turnstile is optional, not required.
async function verifyTurnstile(token, env, remoteip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: remoteip || "",
        }),
      },
    );
    const data = await res.json();
    return !!data.success;
  } catch (e) {
    return false;
  }
}

// Refuse to fetch internal/loopback/link-local addresses so this proxy can't
// be used to probe the Worker's own private network (basic SSRF guard).
// Shared by both the scan endpoint and the deploy-verification endpoint.
//
// This blocklist approach is inherently imperfect (allowlisting resolved IPs
// would be stronger, but Workers' fetch() doesn't expose the resolved
// address before connecting), so it's kept deliberately broad:
//  - all of RFC1918 (10/8, 172.16/12, 192.168/16), not just 10. and 192.168.
//  - loopback (127/8, ::1), link-local (169.254/16, fe80::/10), and
//    IPv4-mapped/compatible IPv6 (::ffff:.../::.../::ffff:0:...)
//  - unique-local IPv6 (fc00::/7) and the "0.0.0.0"/"0.x" catch-all
//  - CGNAT (100.64/10), since it's routable on some internal networks
//  - any hostname that's purely numeric, hex (0x...), or octal (0...), the
//    classic decimal/hex/octal-IP obfuscation tricks used to smuggle a
//    loopback/private address past a naive dotted-quad string check
//    (e.g. "2130706433" or "0x7f000001" both resolve to 127.0.0.1)
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0") return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true; // hex-encoded IP
  if (/^\d+$/.test(h)) return true; // decimal-encoded IP (whole address as one integer)
  if (/^0[0-7]+(\.[0-7]+){0,3}$/.test(h)) return true; // octal-encoded IP
  const ipv4Blocked =
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/;
  if (ipv4Blocked.test(h)) return true;
  const ipv6Blocked =
    /^(::1$|::$|::ffff:0:|::ffff:|64:ff9b::|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/;
  if (ipv6Blocked.test(h)) return true;
  return false;
}

// fetch() with `redirect:"follow"` (Cloudflare Workers' default) would
// transparently chase a 3xx to wherever it points, including straight past
// the isBlockedHost() check above, if a request to an *allowed* host
// redirects to an internal one, that internal response is what the Worker
// would end up fetching. This re-validates the Location header against
// isBlockedHost() before following each hop, capped at a handful of
// redirects, so the guard above can't be bypassed by an attacker-controlled
// redirect chain.
async function safeFetch(url, opts, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, { ...opts, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location"), current);
      if (next.protocol !== "https:" && next.protocol !== "http:")
        throw new Error("Redirected to a disallowed protocol");
      if (isBlockedHost(next.hostname))
        throw new Error("Redirected to a disallowed host");
      current = next.href;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

async function handleScan(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(
    env,
    "scan:" + ip,
    RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (!okRate) {
    return jsonResponse(
      {
        error:
          "Too many scans from this connection, wait a minute and try again.",
      },
      429,
      cors,
    );
  }

  const reqUrl = new URL(request.url);
  const targetUrl = reqUrl.searchParams.get("url");
  const turnstileToken = reqUrl.searchParams.get("ts_token");

  const human = await verifyTurnstile(turnstileToken, env, ip);
  if (!human) {
    return jsonResponse(
      {
        error:
          "Verification failed, please complete the challenge and try again.",
      },
      403,
      cors,
    );
  }

  if (!targetUrl)
    return jsonResponse({ error: 'Missing "url" query parameter' }, 400, cors);

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return jsonResponse({ error: "Invalid URL" }, 400, cors);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return jsonResponse(
      { error: "Only http/https URLs are allowed" },
      400,
      cors,
    );
  }
  // Refuse to fetch internal/loopback/link-local addresses so this proxy can't
  // be used to probe the Worker's own private network (basic SSRF guard).
  if (isBlockedHost(parsed.hostname)) {
    return jsonResponse({ error: "That host isn't allowed" }, 400, cors);
  }

  const cacheKey = "scan:" + parsed.href;
  if (env.SCAN_CACHE) {
    const cached = await env.SCAN_CACHE.get(cacheKey, "json");
    if (cached) return jsonResponse(cached, 200, cors);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await safeFetch(parsed.href, {
      signal: controller.signal,
      headers: { "User-Agent": "PWAfy-Scanner/1.0 (+https://ayodeleayo.dev)" },
    });
    clearTimeout(timeout);

    if (!res.ok)
      return jsonResponse(
        { error: "Upstream responded with " + res.status },
        502,
        cors,
      );
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html"))
      return jsonResponse(
        { error: "URL did not return an HTML page" },
        415,
        cors,
      );

    const reader = res.body.getReader();
    let received = 0;
    let chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_HTML_BYTES) break;
      chunks.push(value);
    }
    const html = new TextDecoder().decode(concatChunks(chunks));
    const meta = await extractMeta(html, parsed.href);

    if (env.SCAN_CACHE) {
      await env.SCAN_CACHE.put(cacheKey, JSON.stringify(meta), {
        expirationTtl: SCAN_CACHE_TTL_SECONDS,
      });
    }
    return jsonResponse(meta, 200, cors);
  } catch (err) {
    return jsonResponse(
      { error: "Could not fetch that URL: " + (err.message || String(err)) },
      502,
      cors,
    );
  }
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/* ============================================================
   1c. VERIFY DEPLOY, checks a real, already-deployed site against
   the same installability criteria the quality score estimates
   client-side, but against what's actually live: fetches the real
   manifest.json, checks required fields and icon declarations, and
   probes for a reachable service worker at the two conventional
   paths. This is the credible "server-verified" companion to the
   pre-deploy heuristic score in score.js.
   ============================================================ */

async function handleVerifyDeploy(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(env, "verify:" + ip, 20, 3600);
  if (!okRate) {
    return jsonResponse(
      {
        error:
          "Too many checks from this connection, wait a bit and try again.",
      },
      429,
      cors,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  const targetUrl = body && body.url;
  if (!targetUrl) return jsonResponse({ error: "Missing url" }, 400, cors);

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return jsonResponse({ error: "Invalid URL" }, 400, cors);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return jsonResponse(
      { error: "Only http/https URLs are allowed" },
      400,
      cors,
    );
  }
  if (isBlockedHost(parsed.hostname)) {
    return jsonResponse({ error: "That host isn't allowed" }, 400, cors);
  }

  const checks = [];
  const push = (pass, weight, label) => checks.push({ pass, weight, label });
  push(parsed.protocol === "https:", 15, "Site is served over HTTPS");

  const fetchWithTimeout = (url, opts) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return safeFetch(url, { ...opts, signal: controller.signal }).finally(() =>
      clearTimeout(timeout),
    );
  };

  let manifestHref = null;
  let html = "";
  try {
    const pageRes = await fetchWithTimeout(parsed.href, {
      headers: { "User-Agent": "PWAfy-Verifier/1.0 (+https://ayodeleayo.dev)" },
    });
    if (pageRes.ok) {
      const reader = pageRes.body.getReader();
      let received = 0;
      let chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_HTML_BYTES) break;
        chunks.push(value);
      }
      html = new TextDecoder().decode(concatChunks(chunks));
    }
  } catch (e) {
    /* handled by the checks below coming back empty/failed */
  }

  let foundManifestLink = false;
  await new HTMLRewriter()
    .on('link[rel~="manifest" i]', {
      element(el) {
        if (!foundManifestLink) {
          foundManifestLink = true;
          const href = el.getAttribute("href");
          if (href) {
            try {
              manifestHref = new URL(href, parsed.href).href;
            } catch (e) {
              /* ignore malformed href */
            }
          }
        }
      },
    })
    .transform(new Response(html))
    .text();

  push(foundManifestLink, 10, "Page links to a manifest file");

  let manifest = null;
  if (manifestHref && !isBlockedHost(new URL(manifestHref).hostname)) {
    try {
      const manRes = await fetchWithTimeout(manifestHref);
      if (manRes.ok) {
        const text = await manRes.text();
        if (text.length < 100000) manifest = JSON.parse(text);
      }
    } catch (e) {
      manifest = null;
    }
  }

  push(!!manifest, 15, "manifest.json is reachable and valid JSON");
  push(!!(manifest && manifest.name), 10, "Manifest has a name");
  push(!!(manifest && manifest.short_name), 8, "Manifest has a short_name");
  push(!!(manifest && manifest.start_url), 8, "Manifest has a start_url");
  push(!!(manifest && manifest.display), 5, "Manifest declares a display mode");
  push(
    !!(
      manifest &&
      /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(manifest.theme_color || "")
    ),
    5,
    "Manifest has a valid theme_color",
  );

  const icons = manifest && Array.isArray(manifest.icons) ? manifest.icons : [];
  const hasLargeIcon = icons.some((ic) => {
    const s = (ic.sizes || "").split("x")[0];
    return parseInt(s, 10) >= 192;
  });
  push(hasLargeIcon, 15, "Manifest declares an icon 192\u00d7192 or larger");
  push(
    icons.some((ic) => (ic.purpose || "").includes("maskable")),
    7,
    "Manifest declares a maskable icon",
  );

  // Heuristic: checks the two conventional service-worker paths (this is
  // exactly where PWAfy's own generated register-sw.js registers one).
  // A site using a different path won't be detected here, that's a real
  // limitation of checking from outside the page's JS execution, not a bug.
  let swFound = false;
  for (const swPath of ["/sw.js", "/service-worker.js"]) {
    try {
      const swUrl = new URL(swPath, parsed.href).href;
      const swRes = await fetchWithTimeout(swUrl, { method: "GET" });
      const ct = swRes.headers.get("content-type") || "";
      if (
        swRes.ok &&
        (ct.includes("javascript") || ct.includes("text/plain"))
      ) {
        swFound = true;
        break;
      }
    } catch (e) {
      /* try the next path */
    }
  }
  push(
    swFound,
    15,
    "A service worker is reachable (checked /sw.js and /service-worker.js)",
  );

  const maxScore = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const total = Math.round((earned / maxScore) * 100);

  return jsonResponse({ total, checks, checkedUrl: parsed.href }, 200, cors);
}

/* ============================================================
   1b. MAGIC-LINK SIGN-IN (Turnstile + rate limit, then proxied to
   Supabase's own OTP endpoint, so a script can no longer hammer
   Supabase directly from the browser to spam someone's inbox).
   Uses SUPABASE_ANON_KEY (a publishable key, safe as a plain var,
   same key already shipped in the frontend's CONFIG).
   ============================================================ */

async function handleSendMagicLink(request, env, cors) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse(
      { error: "Accounts aren't configured on the server yet." },
      501,
      cors,
    );
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(
    env,
    "magiclink:" + ip,
    MAGIC_LINK_RATE_LIMIT_PER_HOUR,
    3600,
  );
  if (!okRate) {
    return jsonResponse(
      { error: "Too many sign-in attempts, wait a while and try again." },
      429,
      cors,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  const { email, ts_token, redirect_to } = body || {};
  if (
    typeof email !== "string" ||
    !EMAIL_RE.test(email) ||
    email.length > 254
  ) {
    return jsonResponse({ error: "Enter a valid email first." }, 400, cors);
  }

  const human = await verifyTurnstile(ts_token, env, ip);
  if (!human) {
    return jsonResponse(
      {
        error:
          "Verification failed, please complete the challenge and try again.",
      },
      403,
      cors,
    );
  }

  // Only ever redirect back to an origin we ourselves serve from, never
  // trust a client-supplied URL outright, or this becomes an open redirect.
  // Falls back to Supabase's dashboard "Site URL" default when the
  // client didn't send one, or sent one we don't recognize.
  const allowedOrigins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let safeRedirect = null;
  if (typeof redirect_to === "string") {
    try {
      const u = new URL(redirect_to);
      if (allowedOrigins.includes(u.origin)) safeRedirect = redirect_to;
    } catch (e) {
      /* ignore malformed redirect_to, fall back to Supabase's Site URL */
    }
  }

  const otpBody = { email, create_user: true };
  if (safeRedirect) otpBody.redirect_to = safeRedirect;

  const res = await fetch(env.SUPABASE_URL + "/auth/v1/otp", {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(otpBody),
  });

  if (!res.ok) {
    let message = "Could not send the sign-in link.";
    try {
      const errData = await res.json();
      if (errData && errData.msg) message = errData.msg;
    } catch (e) {
      /* keep default message */
    }
    return jsonResponse({ error: message }, 502, cors);
  }

  return jsonResponse({ ok: true }, 200, cors);
}

/* ============================================================
   2. PAY WITH TRANSFER, create a dedicated virtual account
   ============================================================ */

async function handleCreateTransferAccount(request, env, cors) {
  if (!env.PAYSTACK_SECRET_KEY)
    return jsonResponse(
      { error: "Payments aren't configured on the server yet." },
      501,
      cors,
    );

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(
    env,
    "transfer:" + ip,
    TRANSFER_RATE_LIMIT_PER_HOUR,
    3600,
  );
  if (!okRate) {
    return jsonResponse(
      { error: "Too many attempts, wait a while and try again." },
      429,
      cors,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  const { plan, user_id, email } = body || {};
  // amount_ngn is intentionally NOT read from the request body, it is
  // always derived from PLAN_PRICES_NGN below, so a tampered client value
  // can never change what a user is actually charged.
  if (!plan || !user_id || !email)
    return jsonResponse({ error: "Missing required fields" }, 400, cors);
  if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES_NGN, plan))
    return jsonResponse({ error: "Unknown plan" }, 400, cors);
  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254)
    return jsonResponse({ error: "Invalid email" }, 400, cors);
  if (typeof user_id !== "string" || !UUID_RE.test(user_id))
    return jsonResponse({ error: "Invalid user id" }, 400, cors);

  // user_id previously came straight from the request body with nothing
  // checking it belonged to whoever was actually calling, so anyone could
  // POST any account's UUID here (visible to that account's teammates via
  // get_team_roster(), for instance) and mint them a virtual account. The
  // webhook only ever upgrades the plan on a real, amount-matched payment,
  // so this was never a way to grant a free upgrade, but it's still the
  // wrong trust boundary: this endpoint should only ever act on behalf of
  // whoever is actually signed in. Verify the bearer token the client sent
  // (its own Supabase session, forwarded from the frontend) actually
  // belongs to user_id before doing anything with it.
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const authHeader = request.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken)
      return jsonResponse({ error: "Sign in first." }, 401, cors);
    let callerId = null;
    try {
      const whoRes = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: "Bearer " + accessToken,
        },
      });
      if (whoRes.ok) {
        const who = await whoRes.json();
        callerId = who && who.id;
      }
    } catch (e) {
      /* callerId stays null, falls through to the 403 below */
    }
    if (!callerId || callerId !== user_id)
      return jsonResponse(
        {
          error:
            "You can only generate a transfer account for your own account.",
        },
        403,
        cors,
      );
  }

  const amount_ngn = PLAN_PRICES_NGN[plan];

  // Create (or reuse) a Paystack customer, then a dedicated virtual account
  // for them. Paystack settles this straight to your account; our webhook
  // is what actually flips the plan once the transfer clears.
  const psHeaders = {
    Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY,
    "Content-Type": "application/json",
  };

  const custRes = await fetch("https://api.paystack.co/customer", {
    method: "POST",
    headers: psHeaders,
    body: JSON.stringify({ email, metadata: { user_id, plan } }),
  });
  const custData = await custRes.json();
  if (!custData.status)
    return jsonResponse(
      { error: custData.message || "Could not create customer" },
      502,
      cors,
    );

  const dvaRes = await fetch("https://api.paystack.co/dedicated_account", {
    method: "POST",
    headers: psHeaders,
    body: JSON.stringify({
      customer: custData.data.customer_code,
      preferred_bank: "wema-bank",
    }),
  });
  const dvaData = await dvaRes.json();
  if (!dvaData.status)
    return jsonResponse(
      { error: dvaData.message || "Could not generate an account number" },
      502,
      cors,
    );

  // Remember which plan this account/customer is paying for, so the webhook
  // knows what to upgrade when the transfer lands.
  if (env.SCAN_CACHE) {
    await env.SCAN_CACHE.put(
      "txaccount:" + dvaData.data.customer.customer_code,
      JSON.stringify({ user_id, plan, amount_ngn }),
      { expirationTtl: 60 * 60 * 24 },
    );
  }

  return jsonResponse(
    {
      bank_name: dvaData.data.bank.name,
      account_number: dvaData.data.account_number,
      account_name: dvaData.data.account_name,
      amount: amount_ngn,
    },
    200,
    cors,
  );
}

/* ============================================================
   3. PAYSTACK WEBHOOK, the only place a plan is ever upgraded
   ============================================================ */

async function verifyPaystackSignature(request, env, rawBody) {
  const signature = request.headers.get("x-paystack-signature");
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.PAYSTACK_SECRET_KEY),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualHex(hex, signature);
}

// Plain `===` on the hex digest leaks how many leading characters matched
// through response-time differences, a textbook timing side-channel for a
// signature check. This always walks the full length of the computed
// digest regardless of where a mismatch occurs.
function timingSafeEqualHex(a, b) {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Sets (or clears) a profile's plan and expiry. Used both by the webhook
// (upgrading, with a real expiresAtIso) and by the cron job (downgrading,
// with plan:'free' and expiresAtIso:null).
async function updateProfilePlan(env, userId, plan, expiresAtIso) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const res = await fetch(
    env.SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ plan, plan_expires_at: expiresAtIso }),
    },
  );
  return res.ok;
}

function planExpiryIso() {
  return new Date(
    Date.now() + PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

async function handlePaystackWebhook(request, env) {
  const rawBody = await request.text();
  const validSig = await verifyPaystackSignature(request, env, rawBody);
  if (!validSig)
    return new Response("invalid signature", {
      status: 401,
      headers: SECURITY_HEADERS,
    });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("invalid payload", {
      status: 400,
      headers: SECURITY_HEADERS,
    });
  }
  const data = event.data || {};

  // Card checkout success. metadata.plan is CLIENT-SUPPLIED (set by the
  // browser during checkout) and must never be trusted on its own, it only
  // says what plan the user *claims* to be paying for. The amount actually
  // charged (data.amount, in kobo, from Paystack's own event) is what's
  // checked against PLAN_PRICES_NGN below, so paying a small amount with a
  // spoofed "agency" metadata tag can no longer grant an upgrade.
  if (event.event === "charge.success" && data.channel !== "dedicated_nuban") {
    const meta = data.metadata || {};
    const requiredNgn = PLAN_PRICES_NGN[meta.plan];
    const chargedNgn = Number(data.amount) / 100;
    if (
      meta.user_id &&
      UUID_RE.test(meta.user_id) &&
      requiredNgn &&
      data.currency === "NGN" &&
      data.status === "success" &&
      chargedNgn >= requiredNgn
    ) {
      await updateProfilePlan(env, meta.user_id, meta.plan, planExpiryIso());
    }
  }

  // Bank transfer received into a dedicated virtual account. The plan and
  // expected amount are looked up from what THIS SERVER stored at account
  // -creation time (handleCreateTransferAccount, which derives amount_ngn
  // from PLAN_PRICES_NGN, not from anything the client sent), never from
  // the webhook payload itself, and the credited amount is checked against
  // that expected amount before upgrading.
  if (
    event.event === "dedicatedaccount.credit" ||
    (event.event === "charge.success" && data.channel === "dedicated_nuban")
  ) {
    const customerCode = data.customer && data.customer.customer_code;
    const creditedNgn = Number(data.amount) / 100;
    if (customerCode && env.SCAN_CACHE) {
      const stored = await env.SCAN_CACHE.get(
        "txaccount:" + customerCode,
        "json",
      );
      if (
        stored &&
        stored.user_id &&
        stored.plan &&
        creditedNgn >= Number(stored.amount_ngn)
      ) {
        await updateProfilePlan(
          env,
          stored.user_id,
          stored.plan,
          planExpiryIso(),
        );
      }
    }
  }

  return new Response("ok", { status: 200, headers: SECURITY_HEADERS });
}

/* ============================================================
   4. SCHEDULED, daily cron: downgrade any expired paid plan.
   Plans are 30-day charges, not real subscriptions (Paystack Inline
   is a one-off charge), so this is what actually enforces "per month"
   instead of a single payment granting access forever.
   ============================================================ */

async function downgradeExpiredPlans(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const nowIso = new Date().toISOString();
  // A single PostgREST request patches every matching row, no need to
  // fetch ids first and loop over them.
  await fetch(
    env.SUPABASE_URL +
      "/rest/v1/profiles?plan=neq.free&plan_expires_at=lt." +
      encodeURIComponent(nowIso),
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ plan: "free", plan_expires_at: null }),
    },
  );
}

/* ============================================================
   PWAfy AI — a small assistant that knows the site, backed by an
   inference API. The key stays server-side (set with
   `wrangler secret put GROQ_API_KEY`, never a plain [vars] entry
   and never shipped to the browser). Every user-facing credit for
   this feature belongs to PWAfy / ayocodes, the underlying provider
   is deliberately never named to the client.
   ============================================================ */

async function handleAskAI(request, env, cors) {
  if (!env.GROQ_API_KEY) {
    return jsonResponse(
      { error: "PWAfy AI isn't configured on the server yet." },
      501,
      cors,
    );
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(
    env,
    "assistant:" + ip,
    ASSISTANT_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (!okRate) {
    return jsonResponse(
      { error: "Too many messages, wait a minute and try again." },
      429,
      cors,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  const { message, history } = body || {};
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > ASSISTANT_MESSAGE_MAX_CHARS
  ) {
    return jsonResponse(
      {
        error:
          "Message must be non-empty and under " +
          ASSISTANT_MESSAGE_MAX_CHARS +
          " characters.",
      },
      400,
      cors,
    );
  }

  // The client's own history is context only, never trusted as anything
  // more, every turn is capped in both count and length, and only
  // user/assistant roles are ever forwarded, so a crafted history can't
  // inject a new system message.
  const cleanHistory = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.length <= ASSISTANT_MESSAGE_MAX_CHARS,
        )
        .slice(-ASSISTANT_HISTORY_MAX_TURNS)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  const messages = [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
    ...cleanHistory,
    { role: "user", content: message },
  ];

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ASSISTANT_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 400,
      }),
    });
    if (!res.ok) {
      // Logged (not sent to the client) so `wrangler tail` shows the real
      // cause, e.g. an expired key or a Groq model deprecation, instead of
      // this always looking like the same silent generic 502.
      const errText = await res.text();
      console.log("Groq error:", res.status, errText);
      return jsonResponse(
        {
          error: "PWAfy AI couldn't process that just now, try again shortly.",
        },
        502,
        cors,
      );
    }
    const data = await res.json();
    const reply =
      data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;
    if (!reply) {
      return jsonResponse(
        { error: "PWAfy AI didn't return a reply, try again." },
        502,
        cors,
      );
    }
    return jsonResponse({ reply }, 200, cors);
  } catch (e) {
    console.log("Groq fetch threw:", e.message || String(e));
    return jsonResponse(
      { error: "Couldn't reach PWAfy AI right now, try again shortly." },
      502,
      cors,
    );
  }
}

/* ============================================================
   Router
   ============================================================ */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS")
      return new Response(null, { headers: { ...cors, ...SECURITY_HEADERS } });

    const url = new URL(request.url);

    if (
      url.pathname === "/create-transfer-account" &&
      request.method === "POST"
    ) {
      return handleCreateTransferAccount(request, env, cors);
    }
    if (url.pathname === "/send-magic-link" && request.method === "POST") {
      return handleSendMagicLink(request, env, cors);
    }
    if (url.pathname === "/verify-deploy" && request.method === "POST") {
      return handleVerifyDeploy(request, env, cors);
    }
    if (url.pathname === "/ask-pwafy-ai" && request.method === "POST") {
      return handleAskAI(request, env, cors);
    }
    if (url.pathname === "/paystack-webhook" && request.method === "POST") {
      // Server-to-server call from Paystack, not a browser, CORS headers
      // don't apply here, so this intentionally doesn't use `cors`.
      return handlePaystackWebhook(request, env);
    }
    if (request.method === "GET") {
      return handleScan(request, env, cors);
    }
    return jsonResponse({ error: "Not found" }, 404, cors);
  },

  // Cloudflare invokes this on the schedule set in wrangler.toml's
  // [triggers] crons, no HTTP request involved.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(downgradeExpiredPlans(env));
  },
};
