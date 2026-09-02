/* ===========================================================
   PWAfy — auth.js
   Accounts + saved presets on Supabase's free tier.
   Passwordless (magic link) — no password storage, no reset flow.
   Built by AYOCODES
   =========================================================== */

const auth = {
  user: null,
  presets: [],
  plan: "free",
  planExpiresAt: null,
  buildsUsed: 0,
};
let supabaseClient = null;

if (SUPABASE_CONFIGURED && window.supabase && window.supabase.createClient) {
  try {
    supabaseClient = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY,
    );
  } catch (e) {
    console.error("PWAfy: could not init Supabase client", e);
  }
}

function planBadge(plan) {
  if (plan === "studio") return "Studio";
  if (plan === "agency") return "Agency";
  return "Free";
}

function formatPlanExpiry(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch (e) {
    return "";
  }
}

function renderAccountBar() {
  const slot = document.getElementById("accountSlot");
  if (!slot) return;
  if (!SUPABASE_CONFIGURED) {
    slot.innerHTML = "";
    return;
  }
  if (auth.user) {
    const initial = (auth.user.email || "?").charAt(0).toUpperCase();
    const cancelBtn =
      auth.plan !== "free"
        ? '<button id="btnCancelPlan">Cancel plan</button>'
        : "";
    slot.innerHTML = `<div class="account-chip"><span class="avatar">${initial}</span>${escapeHtml(auth.user.email)} &middot; ${planBadge(auth.plan)}${cancelBtn}<button id="btnSignOut">Sign out</button></div>`;
    document.getElementById("btnSignOut").onclick = signOut;
    const cancelEl = document.getElementById("btnCancelPlan");
    if (cancelEl) cancelEl.onclick = cancelPlan;
  } else {
    slot.innerHTML = `<button class="btn-signin" id="btnOpenAuth">Sign in</button>`;
    document.getElementById("btnOpenAuth").onclick = openAuthModal;
  }
}

function openAuthModal() {
  document.getElementById("authModal").classList.add("open");
  const note = document.getElementById("authModalConfigNote");
  note.innerHTML = SUPABASE_CONFIGURED
    ? ""
    : '<div class="config-note">Accounts aren\u2019t connected yet — this is a preview. Add a free Supabase project URL and key in CONFIG at the top of state.js.</div>';
  document.getElementById("authModalStatus").innerHTML = "";
}
function closeAuthModal() {
  document.getElementById("authModal").classList.remove("open");
}

async function sendMagicLink() {
  const emailInput = document.getElementById("authEmail");
  const email = (emailInput.value || "").trim();
  const statusEl = document.getElementById("authModalStatus");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    statusEl.innerHTML =
      '<div class="status-line warn">Enter a valid email first.</div>';
    return;
  }
  if (!supabaseClient) {
    statusEl.innerHTML =
      '<div class="status-line warn">Accounts aren\u2019t connected yet.</div>';
    return;
  }
  statusEl.innerHTML =
    '<div class="pw-loader"><span class="ring"></span><span class="msg">Sending link&hellip;</span></div>';
  const { error } = await supabaseClient.auth.signInWithOtp({ email });
  if (error) {
    statusEl.innerHTML =
      '<div class="status-line warn">' + escapeHtml(error.message) + "</div>";
  } else {
    statusEl.innerHTML =
      '<div class="status-line good">Check your inbox for a sign-in link.</div>';
  }
}

async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  auth.user = null;
  auth.presets = [];
  auth.plan = "free";
  auth.planExpiresAt = null;
  auth.buildsUsed = 0;
  renderAccountBar();
  renderPresetsBar();
}

async function loadProfile() {
  if (!supabaseClient || !auth.user) return;
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("plan,plan_expires_at,builds_used")
    .eq("id", auth.user.id)
    .single();
  if (!error && data) {
    auth.plan = data.plan;
    auth.planExpiresAt = data.plan_expires_at;
    auth.buildsUsed = data.builds_used;
  }
}

// Self-serve downgrade. Row Level Security only allows a user to update
// their OWN row and only to plan:'free' with plan_expires_at:null (see
// the "Users can cancel their own plan" policy in supabase-schema.sql) —
// so this can never be used to fake an upgrade, only to cancel one early.
async function cancelPlan() {
  if (!supabaseClient || !auth.user) return;
  if (auth.plan === "free") return;
  const ok = confirm(
    "Cancel your " + planBadge(auth.plan) + " plan and drop back to Free now?",
  );
  if (!ok) return;
  const { error } = await supabaseClient
    .from("profiles")
    .update({ plan: "free", plan_expires_at: null })
    .eq("id", auth.user.id);
  if (error) {
    paymentStatus("Couldn\u2019t cancel: " + error.message, "warn");
    return;
  }
  await loadProfile();
  renderAccountBar();
  paymentStatus(
    "Your plan has been cancelled — you\u2019re back on Free.",
    "info",
  );
}

async function initAuth() {
  if (!supabaseClient) {
    renderAccountBar();
    return;
  }
  const { data } = await supabaseClient.auth.getSession();
  auth.user = data && data.session ? data.session.user : null;
  if (auth.user) {
    await loadProfile();
    await loadPresets();
  }
  renderAccountBar();
  renderPresetsBar();
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    auth.user = session ? session.user : null;
    if (auth.user) {
      await loadProfile();
      await loadPresets();
    } else {
      auth.presets = [];
      auth.plan = "free";
      auth.planExpiresAt = null;
      auth.buildsUsed = 0;
      renderPresetsBar();
    }
    renderAccountBar();
  });
}

async function loadPresets() {
  if (!supabaseClient || !auth.user) return;
  const { data, error } = await supabaseClient
    .from("presets")
    .select("id,name,config,created_at")
    .order("created_at", { ascending: false });
  if (!error && data) auth.presets = data;
  renderPresetsBar();
}

async function saveCurrentAsPreset() {
  const statusEl = document.getElementById("savePresetStatus");
  if (!auth.user) {
    if (statusEl)
      statusEl.innerHTML =
        '<div class="status-line warn">Sign in first to save a preset.</div>';
    return;
  }
  // This client-side check is UX only, so the free-tier limit shows up
  // immediately without a round trip. The real enforcement is the
  // enforce_preset_limit trigger in Postgres (see supabase-schema.sql),
  // which runs no matter how the insert is made.
  if (auth.plan === "free" && auth.presets.length >= 1) {
    if (statusEl)
      statusEl.innerHTML =
        '<div class="status-line warn">Free accounts keep 1 saved preset. <a href="#pricing">Upgrade to Studio</a> for unlimited presets.</div>';
    return;
  }
  const name = prompt(
    'Name this preset (e.g. "Northwind brand"):',
    state.name || "My preset",
  );
  if (!name) return;
  const config = {
    name: state.name,
    shortName: state.shortName,
    description: state.description,
    startUrl: state.startUrl,
    themeColor: state.themeColor,
    bgColor: state.bgColor,
    display: state.display,
    orientation: state.orientation,
    strategy: state.strategy,
    includeSplash: state.includeSplash,
    includeFavicon: state.includeFavicon,
  };
  if (statusEl)
    statusEl.innerHTML =
      '<div class="pw-loader"><span class="ring"></span><span class="msg">Saving&hellip;</span></div>';
  const { error } = await supabaseClient
    .from("presets")
    .insert({ user_id: auth.user.id, name, config });
  if (error) {
    // Surfaces the trigger's exception message verbatim if the server-side
    // limit is what actually blocked it (e.g. a second tab beat this one).
    if (statusEl)
      statusEl.innerHTML =
        '<div class="status-line warn">' + escapeHtml(error.message) + "</div>";
    return;
  }
  if (statusEl)
    statusEl.innerHTML = '<div class="status-line good">Preset saved.</div>';
  await loadPresets();
}

function applyPreset(cfg) {
  Object.assign(state, cfg);
  renderAll();
}

function renderPresetsBar() {
  const bar = document.getElementById("presetsBar");
  if (!bar) return;
  if (!SUPABASE_CONFIGURED) {
    bar.innerHTML = "";
    return;
  }
  if (!auth.user) {
    bar.innerHTML = `<div class="status-line info" style="margin-bottom:18px;">Sign in to load a saved brand preset. <button class="btn-signin" style="margin-left:8px;" id="btnPresetSignIn">Sign in</button></div>`;
    const b = document.getElementById("btnPresetSignIn");
    if (b) b.onclick = openAuthModal;
    return;
  }
  if (!auth.presets.length) {
    bar.innerHTML = `<div class="status-line info" style="margin-bottom:18px;">No saved presets yet — build a PWA and save its settings from the Generate step.</div>`;
    return;
  }
  bar.innerHTML = `
    <div class="presets-bar">
      <select class="presets-select" id="presetSelect">
        <option value="">Load a saved preset&hellip;</option>
        ${auth.presets.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join("")}
      </select>
    </div>
  `;
  document.getElementById("presetSelect").onchange = (e) => {
    const idx = e.target.value;
    if (idx === "") return;
    applyPreset(auth.presets[idx].config);
  };
}
