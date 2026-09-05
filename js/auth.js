/* ===========================================================
   PWAfy — auth.js
   Accounts + saved presets on Supabase's free tier.
   Passwordless (magic link) — no password storage, no reset flow.
   Built by AYOCODES
   =========================================================== */

const auth = {
  user: null,
  presets: [],
<<<<<<< HEAD
  builds: [],
  team: null,
=======
>>>>>>> origin/main
  plan: "free",
  planExpiresAt: null,
  buildsUsed: 0,
};
let supabaseClient = null;

<<<<<<< HEAD
// Turnstile widget state for the auth modal — same pattern as the scan
// step's widget in wizard.js. A no-op whenever Turnstile isn't configured,
// so this stays completely inert until a real TURNSTILE_SITE_KEY is set.
let authTurnstileWidgetId = null;
let authTurnstileToken = null;

function renderAuthTurnstileWidget() {
  const el = document.getElementById("authTurnstileWidget");
  if (!el) return;
  el.innerHTML = "";
  authTurnstileToken = null;
  authTurnstileWidgetId = null;
  if (!TURNSTILE_CONFIGURED || typeof window.turnstile === "undefined") return;
  authTurnstileWidgetId = window.turnstile.render(el, {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    callback: (token) => {
      authTurnstileToken = token;
    },
    "expired-callback": () => {
      authTurnstileToken = null;
    },
    "error-callback": () => {
      authTurnstileToken = null;
    },
  });
}

=======
>>>>>>> origin/main
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

<<<<<<< HEAD
function renderAccountSkeleton() {
  const slot = document.getElementById("accountSlot");
  if (!slot || !SUPABASE_CONFIGURED) return;
  slot.innerHTML =
    '<div class="skeleton skeleton-chip" aria-hidden="true"></div>';
}

=======
>>>>>>> origin/main
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
<<<<<<< HEAD
    const teamBtn =
      auth.plan === "agency" ? '<button id="btnOpenTeam">Team</button>' : "";
    slot.innerHTML = `<div class="account-chip"><span class="avatar">${initial}</span>${escapeHtml(auth.user.email)} &middot; ${planBadge(auth.plan)}${teamBtn}${cancelBtn}<button id="btnSignOut">Sign out</button></div>`;
    document.getElementById("btnSignOut").onclick = signOut;
    const cancelEl = document.getElementById("btnCancelPlan");
    if (cancelEl) cancelEl.onclick = cancelPlan;
    const teamEl = document.getElementById("btnOpenTeam");
    if (teamEl) teamEl.onclick = openTeamModal;
=======
    slot.innerHTML = `<div class="account-chip"><span class="avatar">${initial}</span>${escapeHtml(auth.user.email)} &middot; ${planBadge(auth.plan)}${cancelBtn}<button id="btnSignOut">Sign out</button></div>`;
    document.getElementById("btnSignOut").onclick = signOut;
    const cancelEl = document.getElementById("btnCancelPlan");
    if (cancelEl) cancelEl.onclick = cancelPlan;
>>>>>>> origin/main
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
<<<<<<< HEAD
  renderAuthTurnstileWidget();
=======
>>>>>>> origin/main
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
<<<<<<< HEAD
  if (TURNSTILE_CONFIGURED && !authTurnstileToken) {
    statusEl.innerHTML =
      '<div class="status-line warn">Please complete the verification challenge first.</div>';
    return;
  }
  statusEl.innerHTML =
    '<div class="pw-loader"><span class="ring"></span><span class="msg">Sending link&hellip;</span></div>';

  // Routed through the Worker (which verifies Turnstile + rate-limits by IP)
  // when it's deployed, so a script can't hammer Supabase's OTP endpoint
  // directly from the browser. Falls back to the direct SDK call only when
  // no Worker is configured at all — same "additive, nothing breaks"
  // fallback pattern used elsewhere in this file.
  let error = null;
  if (PROXY_CONFIGURED) {
    try {
      const res = await fetch(CONFIG.PROXY_URL + "/send-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ts_token: authTurnstileToken }),
      });
      const data = await res.json();
      if (!res.ok)
        error = { message: data.error || "Could not send the sign-in link." };
    } catch (e) {
      error = { message: "Could not reach the server. Try again in a moment." };
    }
  } else {
    const result = await supabaseClient.auth.signInWithOtp({ email });
    error = result.error;
  }

  if (
    TURNSTILE_CONFIGURED &&
    window.turnstile &&
    authTurnstileWidgetId !== null
  ) {
    window.turnstile.reset(authTurnstileWidgetId);
    authTurnstileToken = null;
  }

=======
  statusEl.innerHTML =
    '<div class="pw-loader"><span class="ring"></span><span class="msg">Sending link&hellip;</span></div>';
  const { error } = await supabaseClient.auth.signInWithOtp({ email });
>>>>>>> origin/main
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
<<<<<<< HEAD
  auth.builds = [];
  auth.team = null;
=======
>>>>>>> origin/main
  auth.plan = "free";
  auth.planExpiresAt = null;
  auth.buildsUsed = 0;
  renderAccountBar();
  renderPresetsBar();
<<<<<<< HEAD
  renderBuildHistoryBar();
=======
>>>>>>> origin/main
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
<<<<<<< HEAD
  renderAccountSkeleton();
=======
>>>>>>> origin/main
  const { data } = await supabaseClient.auth.getSession();
  auth.user = data && data.session ? data.session.user : null;
  if (auth.user) {
    await loadProfile();
    await loadPresets();
<<<<<<< HEAD
    await loadBuildHistory();
    await loadTeam();
=======
>>>>>>> origin/main
  }
  renderAccountBar();
  renderPresetsBar();
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    auth.user = session ? session.user : null;
    if (auth.user) {
      await loadProfile();
      await loadPresets();
<<<<<<< HEAD
      await loadBuildHistory();
      await loadTeam();
    } else {
      auth.presets = [];
      auth.builds = [];
      auth.team = null;
=======
    } else {
      auth.presets = [];
>>>>>>> origin/main
      auth.plan = "free";
      auth.planExpiresAt = null;
      auth.buildsUsed = 0;
      renderPresetsBar();
<<<<<<< HEAD
      renderBuildHistoryBar();
=======
>>>>>>> origin/main
    }
    renderAccountBar();
  });
}

async function loadPresets() {
  if (!supabaseClient || !auth.user) return;
<<<<<<< HEAD
  const bar = document.getElementById("presetsBar");
  if (bar)
    bar.innerHTML =
      '<div class="skeleton skeleton-bar" aria-hidden="true"></div>';
=======
>>>>>>> origin/main
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
<<<<<<< HEAD

/* ============================================================
   Build history — a lightweight, automatic record of recent builds
   (config only, same as presets — never the icon itself) so a signed-in
   user can reload a recent build's settings without re-uploading anything.
   ============================================================ */

async function saveBuildRecord(qualityScore) {
  if (!supabaseClient || !auth.user) return; // best-effort — never blocks a download
  const name = state.name || state.shortName || "Untitled build";
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
  try {
    await supabaseClient.from("builds").insert({
      user_id: auth.user.id,
      name,
      config,
      quality_score: qualityScore,
    });
    await loadBuildHistory();
  } catch (e) {
    /* history is a convenience, not a requirement — swallow failures */
  }
}

async function loadBuildHistory() {
  if (!supabaseClient || !auth.user) return;
  const { data, error } = await supabaseClient
    .from("builds")
    .select("id,name,config,quality_score,created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  if (!error && data) auth.builds = data;
  renderBuildHistoryBar();
}

function renderBuildHistoryBar() {
  const bar = document.getElementById("buildHistoryBar");
  if (!bar) return;
  if (!SUPABASE_CONFIGURED || !auth.user || !auth.builds.length) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = `
    <div class="field">
      <label>Recent builds</label>
      <select class="presets-select" id="buildHistorySelect">
        <option value="">Reload a recent build&hellip;</option>
        ${auth.builds
          .map(
            (b, i) =>
              `<option value="${i}">${escapeHtml(b.name)} \u00b7 ${new Date(b.created_at).toLocaleDateString()}${b.quality_score != null ? " \u00b7 " + b.quality_score + "/100" : ""}</option>`,
          )
          .join("")}
      </select>
    </div>
  `;
  document.getElementById("buildHistorySelect").onchange = (e) => {
    const idx = e.target.value;
    if (idx === "") return;
    applyPreset(auth.builds[idx].config);
  };
}

/* ============================================================
   Teams (Agency plan) — a shared workspace where teammates can see
   each other's saved presets. Membership changes only ever happen
   through the security-definer RPCs below (create_team,
   create_team_invite, redeem_team_invite) — there's no direct table
   write path for a regular user, so all of the actual rules (agency
   plan required, one team per user, invite validity) are enforced in
   Postgres, not just in this client code.
   ============================================================ */

async function loadTeam() {
  if (!supabaseClient || !auth.user) {
    auth.team = null;
    return;
  }
  const { data: membership } = await supabaseClient
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!membership) {
    auth.team = null;
    return;
  }
  const { data: team } = await supabaseClient
    .from("teams")
    .select("id, name, owner_id")
    .eq("id", membership.team_id)
    .single();
  auth.team = team ? { ...team, myRole: membership.role } : null;
}

function openTeamModal() {
  document.getElementById("teamModal").classList.add("open");
  renderTeamPanel();
}
function closeTeamModal() {
  document.getElementById("teamModal").classList.remove("open");
}

async function createTeamNow() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.rpc("create_team", {
    team_name: "My team",
  });
  if (error) {
    renderTeamPanel(error.message);
    return;
  }
  await loadTeam();
  renderTeamPanel();
}

async function generateTeamInvite() {
  if (!supabaseClient || !auth.team) return;
  const { data, error } = await supabaseClient.rpc("create_team_invite", {
    p_team_id: auth.team.id,
  });
  if (error) {
    renderTeamPanel(error.message);
    return;
  }
  renderTeamPanel(null, data);
}

async function joinTeamWithCode() {
  const input = document.getElementById("teamInviteCodeInput");
  const code = ((input && input.value) || "").trim();
  if (!code || !supabaseClient) return;
  const { error } = await supabaseClient.rpc("redeem_team_invite", {
    p_code: code,
  });
  if (error) {
    renderTeamPanel(error.message);
    return;
  }
  await loadTeam();
  renderTeamPanel();
}

async function renderTeamPanel(errorMsg, freshInviteCode) {
  const body = document.getElementById("teamPanelBody");
  if (!body) return;

  if (auth.plan !== "agency") {
    body.innerHTML =
      '<div class="status-line info">Teams are an Agency-plan feature. <a href="#pricing">Upgrade to Agency</a> to create one.</div>';
    return;
  }

  if (errorMsg) {
    body.innerHTML = `<div class="status-line warn">${escapeHtml(errorMsg)}</div>`;
  }

  if (!auth.team) {
    body.innerHTML += `
      <p>You're not on a team yet.</p>
      <div class="generate-btn-row">
        <button class="btn-primary" id="btnCreateTeam" style="flex:1;">Create a team</button>
      </div>
      <div class="field" style="margin-top:14px;">
        <label for="teamInviteCodeInput">Have an invite code?</label>
        <input type="text" id="teamInviteCodeInput" placeholder="Paste invite code">
      </div>
      <button class="btn-ghost" id="btnJoinTeam">Join team</button>
    `;
    const createBtn = document.getElementById("btnCreateTeam");
    if (createBtn) createBtn.onclick = createTeamNow;
    const joinBtn = document.getElementById("btnJoinTeam");
    if (joinBtn) joinBtn.onclick = joinTeamWithCode;
    return;
  }

  let rosterHtml =
    '<div class="status-line info">Loading team roster\u2026</div>';
  body.innerHTML += `<h4>${escapeHtml(auth.team.name)}</h4><div id="teamRoster">${rosterHtml}</div>`;

  if (auth.team.myRole === "owner") {
    body.innerHTML += `
      <div class="generate-btn-row" style="margin-top:14px;">
        <button class="btn-primary" id="btnGenInvite" style="flex:1;">Generate invite code</button>
      </div>
      ${
        freshInviteCode
          ? `<div class="status-line good">Invite code (single-use, expires in 7 days): <code>${escapeHtml(freshInviteCode)}</code></div>`
          : ""
      }
    `;
    const genBtn = document.getElementById("btnGenInvite");
    if (genBtn) genBtn.onclick = generateTeamInvite;
  }

  const { data: roster, error: rosterErr } = await supabaseClient.rpc(
    "get_team_roster",
    { p_team_id: auth.team.id },
  );
  const rosterEl = document.getElementById("teamRoster");
  if (rosterEl) {
    if (rosterErr || !roster) {
      rosterEl.innerHTML =
        '<div class="status-line warn">Could not load the team roster.</div>';
    } else {
      rosterEl.innerHTML = roster
        .map(
          (m) =>
            `<div class="roster-row"><span class="roster-email">${escapeHtml(m.email)}</span><span class="roster-role">${m.role}</span></div>`,
        )
        .join("");
    }
  }
}
=======
>>>>>>> origin/main
