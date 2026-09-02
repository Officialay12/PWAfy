/* ===========================================================
   PWAfy — payments.js
   Card checkout via Paystack Inline (free to integrate — Paystack
   only takes a per-transaction %, no monthly cost) plus a real
   "pay with bank transfer" flow using Paystack's dedicated virtual
   account charge type. Verification always happens server-side —
   never trust the client's "success" callback for a paid feature.
   Built by AYOCODES
   =========================================================== */

const CURRENCY_SYMBOLS = {
  NGN: "\u20a6",
  USD: "$",
  GBP: "\u00a3",
  EUR: "\u20ac",
  GHS: "\u20b5",
  KES: "KSh",
  ZAR: "R",
};
let fxRates = null; // { USD: 0.00061, GBP: ... } per 1 NGN, fetched once
let selectedCurrency = "NGN";

// Free, keyless FX endpoint — good enough for a display estimate.
// Rates are cached for the session so we don't hammer it on every keystroke.
async function loadFxRates() {
  if (fxRates) return fxRates;
  try {
    const cached = sessionStorage.getItem("pwafy_fx");
    if (cached) {
      fxRates = JSON.parse(cached);
      return fxRates;
    }
    const res = await fetch("https://open.er-api.com/v6/latest/NGN");
    const data = await res.json();
    if (data && data.rates) {
      fxRates = data.rates;
      sessionStorage.setItem("pwafy_fx", JSON.stringify(fxRates));
    }
  } catch (e) {
    /* fine — we just show naira if this fails */
  }
  return fxRates;
}

function formatPrice(ngnAmount, currency) {
  if (currency === "NGN" || !fxRates || !fxRates[currency]) {
    return CURRENCY_SYMBOLS.NGN + ngnAmount.toLocaleString();
  }
  const converted = ngnAmount * fxRates[currency];
  const rounded =
    converted < 10
      ? converted.toFixed(2)
      : Math.round(converted).toLocaleString();
  return CURRENCY_SYMBOLS[currency] + rounded;
}

async function updatePricingDisplay() {
  await loadFxRates();
  const studioEl = document.getElementById("studioPrice");
  const agencyEl = document.getElementById("agencyPrice");
  const studioPeriod = document.getElementById("studioPeriod");
  const agencyPeriod = document.getElementById("agencyPeriod");
  studioEl.textContent = formatPrice(CONFIG.STUDIO_PRICE_NGN, selectedCurrency);
  agencyEl.textContent = formatPrice(CONFIG.AGENCY_PRICE_NGN, selectedCurrency);
  const approxNote = selectedCurrency === "NGN" ? "" : " (approx.)";
  studioPeriod.textContent =
    "per month" + approxNote + " \u00b7 unlimited builds";
  agencyPeriod.textContent =
    "per month" + approxNote + " \u00b7 for client work";
}

function paymentStatus(msg, type) {
  const el = document.getElementById("pricingStatus");
  el.innerHTML = `<div class="status-line ${type}">${type === "info" ? '<span class="ring" style="width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--ink);border-radius:50%;display:inline-block;"></span>' : ""}${escapeHtml(msg)}</div>`;
}

function planAmountNgn(plan) {
  return plan === "agency" ? CONFIG.AGENCY_PRICE_NGN : CONFIG.STUDIO_PRICE_NGN;
}

/* ---------------- Card checkout (Paystack Inline) ---------------- */
function startCardCheckout(plan) {
  if (!PAYSTACK_CONFIGURED) {
    paymentStatus(
      "Payments aren\u2019t connected yet — this is a preview. Add a Paystack public key in CONFIG to enable checkout.",
      "warn",
    );
    return;
  }
  if (!auth.user) {
    paymentStatus("Sign in first so we know which account to upgrade.", "warn");
    openAuthModal();
    return;
  }
  const amountKobo = planAmountNgn(plan) * 100;
  const handler = PaystackPop.setup({
    key: CONFIG.PAYSTACK_PUBLIC_KEY,
    email: auth.user.email,
    amount: amountKobo,
    currency: "NGN",
    metadata: { plan, user_id: auth.user.id },
    callback: function (response) {
      // This "success" callback is UX-only. The plan is NOT upgraded here —
      // it flips only once our Worker's webhook independently verifies the
      // charge with Paystack's secret key server-side. Faking this callback
      // client-side must never be able to grant access.
      paymentStatus(
        "Payment received — confirming with the server, this can take a few seconds\u2026",
        "info",
      );
      pollForPlanUpgrade(plan);
    },
    onClose: function () {
      paymentStatus("Checkout closed — no charge was made.", "info");
    },
  });
  handler.openIframe();
}

/* ---------------- Pay with bank transfer ---------------- */
async function startTransferCheckout(plan) {
  if (!auth.user) {
    paymentStatus("Sign in first so we know which account to upgrade.", "warn");
    openAuthModal();
    return;
  }
  const modal = document.getElementById("transferModal");
  const note = document.getElementById("transferModalConfigNote");
  const details = document.getElementById("transferDetails");
  const statusEl = document.getElementById("transferStatus");
  modal.classList.add("open");
  details.innerHTML = "";
  statusEl.innerHTML = "";

  if (!PROXY_CONFIGURED || !PAYSTACK_CONFIGURED) {
    note.innerHTML =
      '<div class="config-note">Bank transfer isn\u2019t connected yet — this is a preview of the flow. Deploy the Worker and add a Paystack key to enable it for real.</div>';
    return;
  }
  note.innerHTML = "";
  statusEl.innerHTML =
    '<div class="pw-loader"><span class="ring"></span><span class="msg">Generating a one-time account number\u2026</span></div>';

  try {
    const res = await fetch(CONFIG.PROXY_URL + "/create-transfer-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan,
        amount_ngn: planAmountNgn(plan),
        user_id: auth.user.id,
        email: auth.user.email,
      }),
    });
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    details.innerHTML = `
      <div class="transfer-box">
        <div class="tr-row"><span class="tr-label">Bank</span><span>${escapeHtml(data.bank_name)}</span></div>
        <div class="tr-row"><span class="tr-label">Account number</span><span>${escapeHtml(data.account_number)}</span></div>
        <div class="tr-row"><span class="tr-label">Account name</span><span>${escapeHtml(data.account_name)}</span></div>
        <div class="tr-row"><span class="tr-label">Amount</span><span>\u20a6${Number(data.amount).toLocaleString()}</span></div>
      </div>
    `;
    statusEl.innerHTML =
      '<div class="status-line info"><span class="ring" style="width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--ink);border-radius:50%;display:inline-block;"></span> Waiting for the transfer to land\u2026 this page updates itself, you don\u2019t need to refresh.</div>';
    pollForPlanUpgrade(plan, statusEl);
  } catch (err) {
    statusEl.innerHTML =
      '<div class="status-line bad">Couldn\u2019t generate an account number right now: ' +
      escapeHtml(err.message) +
      ". Try again in a moment.</div>";
  }
}

// The account plan is only ever changed server-side, after the Worker's
// Paystack webhook verifies the charge with the secret key. This just
// re-checks the user's profile row until it flips.
async function pollForPlanUpgrade(plan, statusEl) {
  if (!supabaseClient || !auth.user) return;
  let attempts = 0;
  const maxAttempts = 40; // ~2 minutes at 3s intervals
  const interval = setInterval(async () => {
    attempts++;
    await loadProfile();
    if (auth.plan === plan || auth.plan === "agency") {
      clearInterval(interval);
      renderAccountBar();
      const expiry = formatPlanExpiry(auth.planExpiresAt);
      const msg =
        "You\u2019re on " +
        planBadge(auth.plan) +
        " now. Thanks!" +
        (expiry ? " Active until " + expiry + "." : "");
      if (statusEl)
        statusEl.innerHTML = '<div class="status-line good">' + msg + "</div>";
      paymentStatus(msg, "good");
      return;
    }
    if (attempts >= maxAttempts) {
      clearInterval(interval);
      const msg =
        "Still waiting on confirmation — if you\u2019ve paid, this can take a minute longer; your plan updates automatically the moment it clears.";
      if (statusEl)
        statusEl.innerHTML = '<div class="status-line info">' + msg + "</div>";
    }
  }, 3000);
}

function closeTransferModal() {
  document.getElementById("transferModal").classList.remove("open");
}
