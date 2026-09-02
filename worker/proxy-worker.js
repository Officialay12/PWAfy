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
const PLAN_DURATION_DAYS = 30; // how long a paid plan lasts after a successful charge

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

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: cors });
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

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return true; // if the KV isn't bound yet, don't block — fail open
  const key = "rl:" + ip + ":" + Math.floor(Date.now() / 60000);
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_MINUTE) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 90 });
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

async function handleScan(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const okRate = await checkRateLimit(env, ip);
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
  const blockedHosts =
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1|\[?::1\]?)/i;
  if (blockedHosts.test(parsed.hostname)) {
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
   2. PAY WITH TRANSFER — create a dedicated virtual account
   ============================================================ */

async function handleCreateTransferAccount(request, env, cors) {
  if (!env.PAYSTACK_SECRET_KEY)
    return jsonResponse(
      { error: "Payments aren't configured on the server yet." },
      501,
      cors,
    );

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  const { plan, amount_ngn, user_id, email } = body;
  if (!plan || !amount_ngn || !user_id || !email)
    return jsonResponse({ error: "Missing required fields" }, 400, cors);
  if (!["studio", "agency"].includes(plan))
    return jsonResponse({ error: "Unknown plan" }, 400, cors);

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
  if (!validSig) return new Response("invalid signature", { status: 401 });

  const event = JSON.parse(rawBody);

  // Card checkout success
  if (event.event === "charge.success") {
    const meta = event.data.metadata || {};
    if (meta.user_id && meta.plan) {
      await updateProfilePlan(env, meta.user_id, meta.plan, planExpiryIso());
    }
  }

  // Bank transfer received into a dedicated virtual account
  if (
    event.event === "dedicatedaccount.credit" ||
    (event.event === "charge.success" &&
      event.data.channel === "dedicated_nuban")
  ) {
    const customerCode =
      event.data.customer && event.data.customer.customer_code;
    if (customerCode && env.SCAN_CACHE) {
      const stored = await env.SCAN_CACHE.get(
        "txaccount:" + customerCode,
        "json",
      );
      if (stored)
        await updateProfilePlan(
          env,
          stored.user_id,
          stored.plan,
          planExpiryIso(),
        );
    }
  }

  return new Response("ok", { status: 200 });
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
      return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (
      url.pathname === "/create-transfer-account" &&
      request.method === "POST"
    ) {
      return handleCreateTransferAccount(request, env, cors);
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
