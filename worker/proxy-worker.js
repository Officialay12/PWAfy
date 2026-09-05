// PWAfy — backend Worker
// Deploy this to Cloudflare Workers (free tier: 100,000 requests/day,
// no cost at PWAfy's scale). Handles four things, all under one Worker
// so there's only one thing to deploy and one URL to configure:
//
//   GET  /?url=...&ts_token=...   -> scan a site (title/description/theme-color/icon)
//   POST /create-transfer-account  -> generate a Paystack dedicated virtual account
//   POST /paystack-webhook         -> verify a payment server-side and upgrade the plan
//   (cron) scheduled               -> downgrade any expired paid plan back to free
//
// Required bindings/secrets (all free to create):
//   - KV namespace bound as SCAN_CACHE   (Workers KV free tier)
//   - KV namespace bound as RATE_LIMIT   (Workers KV free tier)
//   - Secret PAYSTACK_SECRET_KEY         (wrangler secret put PAYSTACK_SECRET_KEY)
//   - Secret SUPABASE_SERVICE_ROLE_KEY   (wrangler secret put SUPABASE_SERVICE_ROLE_KEY)
//   - Secret TURNSTILE_SECRET_KEY        (wrangler secret put TURNSTILE_SECRET_KEY —
//                                          optional; scan works without it, just with
//                                          less abuse protection)
//   - Var    SUPABASE_URL                (wrangler.toml [vars])
//   - Var    ALLOWED_ORIGINS             (wrangler.toml [vars] — comma-separated list
//                                          of browser origins allowed to call this Worker)
//
// Deploy steps:
//   1. npm install -g wrangler
//   2. wrangler init pwafy-worker   (choose "Hello World Worker", TypeScript: no)
//   3. wrangler kv:namespace create SCAN_CACHE
//      wrangler kv:namespace create RATE_LIMIT
//      -> paste the returned IDs into wrangler.toml under [[kv_namespaces]]
//   4. wrangler secret put PAYSTACK_SECRET_KEY
//      wrangler secret put SUPABASE_SERVICE_ROLE_KEY
//      wrangler secret put TURNSTILE_SECRET_KEY
//   5. Replace the generated src/index.js with this file's contents
//   6. wrangler deploy
//   7. Copy the resulting workers.dev URL into CONFIG.PROXY_URL in js/state.js
//   8. In your Paystack dashboard, point the webhook URL at
//      <your-worker-url>/paystack-webhook
//   9. Set ALLOWED_ORIGINS in wrangler.toml to your real site's origin(s)
//      before going live — it defaults to localhost only.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 2_000_000; // 2MB cap so a huge page can't tie up the worker
const SCAN_CACHE_TTL_SECONDS = 60 * 60 * 6; // 6 hours — cuts repeat-scan load a lot
const RATE_LIMIT_PER_MINUTE = 12; // per client IP, on the scan endpoint only
const TRANSFER_RATE_LIMIT_PER_HOUR = 6; // per client IP, on account-creation only
const MAGIC_LINK_RATE_LIMIT_PER_HOUR = 5; // per client IP, on sign-in requests
const PLAN_DURATION_DAYS = 30; // how long a paid plan lasts after a successful charge

// SOURCE OF TRUTH for plan prices. Never trust a client-supplied amount —
// the frontend's CONFIG.STUDIO_PRICE_NGN / AGENCY_PRICE_NGN are for display
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
  const allowList = (env.ALLOWED_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
// CSP is safe here — there is no page context for it to break.
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
  if (!env.RATE_LIMIT) return true; // if the KV isn't bound yet, don't block — fail open
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
// frontend's TURNSTILE_CONFIGURED gate — Turnstile is optional, not required.
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
function isBlockedHost(hostname) {
  const blockedHosts =
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1|\[?::1\]?)/i;
  return blockedHosts.test(hostname);
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
          "Too many scans from this connection — wait a minute and try again.",
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
          "Verification failed — please complete the challenge and try again.",
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
    const res = await fetch(parsed.href, {
      signal: controller.signal,
      headers: { "User-Agent": "PWAfy-Scanner/1.0 (+https://ayodeleayo.dev)" },
      redirect: "follow",
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
   1c. VERIFY DEPLOY — checks a real, already-deployed site against
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
          "Too many checks from this connection — wait a bit and try again.",
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
    return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
      clearTimeout(timeout),
    );
  };

  let manifestHref = null;
  let html = "";
  try {
    const pageRes = await fetchWithTimeout(parsed.href, {
      headers: { "User-Agent": "PWAfy-Verifier/1.0 (+https://ayodeleayo.dev)" },
      redirect: "follow",
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
  // A site using a different path won't be detected here — that's a real
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
   Supabase's own OTP endpoint — so a script can no longer hammer
   Supabase directly from the browser to spam someone's inbox).
   Uses SUPABASE_ANON_KEY (a publishable key — safe as a plain var,
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
      { error: "Too many sign-in attempts — wait a while and try again." },
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
  const { email, ts_token } = body || {};
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
          "Verification failed — please complete the challenge and try again.",
      },
      403,
      cors,
    );
  }

  const res = await fetch(env.SUPABASE_URL + "/auth/v1/otp", {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    // create_user:true matches the original signInWithOtp() default — first
    // sign-in doubles as account creation, same as before this was proxied.
    body: JSON.stringify({ email, create_user: true }),
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
   2. PAY WITH TRANSFER — create a dedicated virtual account
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
      { error: "Too many attempts — wait a while and try again." },
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
  // amount_ngn is intentionally NOT read from the request body — it is
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
   3. PAYSTACK WEBHOOK — the only place a plan is ever upgraded
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
  return hex === signature;
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
  // browser during checkout) and must never be trusted on its own — it only
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
  // from PLAN_PRICES_NGN, not from anything the client sent) — never from
  // the webhook payload itself — and the credited amount is checked against
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
   4. SCHEDULED — daily cron: downgrade any expired paid plan.
   Plans are 30-day charges, not real subscriptions (Paystack Inline
   is a one-off charge), so this is what actually enforces "per month"
   instead of a single payment granting access forever.
   ============================================================ */

async function downgradeExpiredPlans(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const nowIso = new Date().toISOString();
  // A single PostgREST request patches every matching row — no need to
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
    if (url.pathname === "/paystack-webhook" && request.method === "POST") {
      // Server-to-server call from Paystack, not a browser — CORS headers
      // don't apply here, so this intentionally doesn't use `cors`.
      return handlePaystackWebhook(request, env);
    }
    if (request.method === "GET") {
      return handleScan(request, env, cors);
    }
    return jsonResponse({ error: "Not found" }, 404, cors);
  },

  // Cloudflare invokes this on the schedule set in wrangler.toml's
  // [triggers] crons — no HTTP request involved.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(downgradeExpiredPlans(env));
  },
};
