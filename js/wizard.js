/* ===========================================================
   PWAfy — wizard.js
   Renders each of the 5 wizard steps and handles navigation.
   Built by AYOCODES
   =========================================================== */

const els = {
  stepsNav: null,
  stepBody: null,
  errBox: null,
  fileList: null,
};

function cacheEls() {
  els.stepsNav = document.getElementById("stepsNav");
  els.stepBody = document.getElementById("stepBody");
  els.errBox = document.getElementById("errBox");
  els.fileList = document.getElementById("fileList");
}

/* ---------------- Validation ---------------- */
function validateStep(i) {
  const errs = [];
  if (i === 1) {
    if (!state.name.trim()) errs.push("App name is required.");
    if (state.shortName.trim().length > 12)
      errs.push(
        "Short name should be 12 characters or fewer for home screen labels.",
      );
    if (!state.startUrl.trim())
      errs.push('Start URL is required (use "/" for the site root).');
  }
  if (i === 2) {
    if (!state.iconImg)
      errs.push(
        "Upload a source icon (square PNG or JPG, 512\u00d7512 or larger recommended).",
      );
  }
  return errs;
}

/* ---------------- Step nav ---------------- */
function renderStepsNav() {
  els.stepsNav.innerHTML = "";
  STEP_DEFS.forEach((def, i) => {
    const btn = document.createElement("button");
    btn.className =
      "step-tab" +
      (i === state.step ? " active" : "") +
      (i < state.step ? " done" : "");
    btn.innerHTML =
      '<span class="n">Step ' +
      (i + 1) +
      '</span><span class="t">' +
      def.label +
      "</span>";
    btn.addEventListener("click", () => {
      if (i <= state.step) {
        goToStep(i);
        return;
      }
      let ok = true;
      for (let s = state.step; s < i; s++) {
        if (validateStep(s).length) {
          ok = false;
          break;
        }
      }
      if (ok) goToStep(i);
    });
    els.stepsNav.appendChild(btn);
  });
}

function goToStep(i) {
  els.errBox.innerHTML = "";
  state.step = i;
  renderAll();
  els.stepBody.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function nextStep() {
  const errs = validateStep(state.step);
  if (errs.length) {
    showErrors(errs);
    return;
  }
  els.errBox.innerHTML = "";
  if (state.step < STEP_DEFS.length - 1) {
    state.step++;
    renderAll();
  }
}

function prevStep() {
  els.errBox.innerHTML = "";
  if (state.step > 0) {
    state.step--;
    renderAll();
  }
}

function showErrors(errs) {
  els.errBox.innerHTML =
    '<div class="err-list"><strong>Fix these before continuing:</strong><ul>' +
    errs.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") +
    "</ul></div>";
  els.errBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- Step renderers ---------------- */
function renderStepBody() {
  const i = state.step;
  if (i === 0) return renderSource();
  if (i === 1) return renderIdentity();
  if (i === 2) return renderIcon();
  if (i === 3) return renderBehavior();
  if (i === 4) return renderGenerate();
}

function renderSource() {
  els.stepBody.innerHTML = `
    <div class="step-title">Where should we start?</div>
    <p class="step-desc">Scan a live URL to pull in what we can read from it, or skip straight to filling the details in yourself. Either path produces the same output.</p>
    <div id="presetsBar"></div>
    <div class="tabs-inline">
      <button id="tabScan" class="${state.sourceMode === "scan" ? "active" : ""}">Scan a URL</button>
      <button id="tabManual" class="${state.sourceMode === "manual" ? "active" : ""}">Enter manually</button>
    </div>
    <div id="sourcePanel"></div>
    <div class="step-actions">
      <span></span>
      <button class="btn-next" id="btnNext0">Continue</button>
    </div>
  `;
  document.getElementById("tabScan").onclick = () => {
    state.sourceMode = "scan";
    renderStepBody();
  };
  document.getElementById("tabManual").onclick = () => {
    state.sourceMode = "manual";
    renderStepBody();
  };
  document.getElementById("btnNext0").onclick = nextStep;

  const panel = document.getElementById("sourcePanel");
  if (state.sourceMode === "scan") {
    panel.innerHTML = `
      <div class="field">
        <label for="scanUrl">Site URL</label>
        <div class="scan-row">
          <input type="url" id="scanUrl" placeholder="https://example.com" value="${escapeHtml(state.scanUrl)}">
          <button class="btn-scan" id="btnScan">Scan</button>
        </div>
        <div class="hint">We'll try to read the title, description, theme color and favicon directly from the page. Many sites block cross-origin reads by design — if that happens, you'll drop straight into manual entry with nothing lost.</div>
      </div>
      <div id="scanStatus"></div>
      <div id="turnstileWidget"></div>
    `;
    document.getElementById("scanUrl").oninput = (e) =>
      (state.scanUrl = e.target.value);
    document.getElementById("btnScan").onclick = doScan;
    renderScanStatus();
    renderTurnstileWidget();
  } else {
    panel.innerHTML = `<div class="status-line info">Manual entry selected. Continue to fill in your app's name, colors and behavior.</div>`;
  }
  renderPresetsBar();
}

function renderScanStatus() {
  const box = document.getElementById("scanStatus");
  if (!box) return;
  if (!state.scanStatus) {
    box.innerHTML = "";
    return;
  }
  const s = state.scanStatus;
  if (s.type === "info") {
    box.innerHTML = `<div class="pw-loader" style="margin-top:14px;"><span class="ring"></span><span class="msg">${escapeHtml(s.message)}</span></div>`;
  } else {
    box.innerHTML = `<div class="status-line ${s.type}">${escapeHtml(s.message)}</div>`;
  }
}

// Renders (or clears) the Turnstile challenge in the scan panel. A no-op
// whenever Turnstile isn't configured, so this stays completely inert
// until a real TURNSTILE_SITE_KEY is set in CONFIG — nothing else in the
// scan flow behaves differently in that default state.
function renderTurnstileWidget() {
  const el = document.getElementById("turnstileWidget");
  if (!el) return;
  turnstileToken = null;
  turnstileWidgetId = null;
  if (!TURNSTILE_CONFIGURED || typeof window.turnstile === "undefined") {
    el.innerHTML = "";
    return;
  }
  turnstileWidgetId = window.turnstile.render(el, {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    callback: (token) => {
      turnstileToken = token;
    },
    "expired-callback": () => {
      turnstileToken = null;
    },
    "error-callback": () => {
      turnstileToken = null;
    },
  });
}

async function doScan() {
  const url = state.scanUrl.trim();
  if (!url) {
    state.scanStatus = { type: "warn", message: "Enter a URL first." };
    renderScanStatus();
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    state.scanStatus = {
      type: "warn",
      message: "That doesn't look like a valid URL. Include https://",
    };
    renderScanStatus();
    return;
  }
  state.scanStatus = {
    type: "info",
    message: "Reading " + parsed.hostname + "\u2026",
  };
  renderScanStatus();
  const btn = document.getElementById("btnScan");
  if (btn) btn.disabled = true;

  let succeeded = false;
  try {
    succeeded = await tryDirectFetch(url, parsed);
  } catch (err) {
    succeeded = false;
  }

  if (!succeeded && PROXY_CONFIGURED) {
    if (TURNSTILE_CONFIGURED && !turnstileToken) {
      state.scanStatus = {
        type: "warn",
        message:
          "Please complete the verification challenge below, then try scanning again.",
      };
      renderScanStatus();
      if (btn) btn.disabled = false;
      return;
    }
    state.scanStatus = {
      type: "info",
      message: "Direct read was blocked — trying the scanning proxy\u2026",
    };
    renderScanStatus();
    try {
      succeeded = await tryProxyFetch(url, parsed);
    } catch (err) {
      succeeded = false;
    }
    // Turnstile tokens are single-use — reset so the next scan needs a fresh solve.
    if (
      TURNSTILE_CONFIGURED &&
      window.turnstile &&
      turnstileWidgetId !== null
    ) {
      window.turnstile.reset(turnstileWidgetId);
      turnstileToken = null;
    }
  }

  if (succeeded) {
    state.scanStatus = {
      type: "good",
      message:
        "Pulled what we could from the page. Review and adjust on the next steps.",
    };
  } else {
    const proxyHint = PROXY_CONFIGURED
      ? "Both the direct read and the proxy were blocked."
      : "Couldn't read that site automatically — likely blocked by its cross-origin policy. Deploying proxy-worker.js removes this limitation for most sites.";
    state.scanStatus = {
      type: "warn",
      message:
        proxyHint +
        " Switch to manual entry below, or continue and fill the details in yourself.",
    };
  }
  if (btn) btn.disabled = false;
  renderScanStatus();
  renderPreview();
}

async function applyScannedMeta(meta, parsed) {
  const title = (meta.title || parsed.hostname).trim();
  state.name = title.slice(0, 45);
  state.shortName = slugShortName(title);
  if (meta.description)
    state.description = meta.description.trim().slice(0, 300);
  if (meta.themeColor)
    state.themeColor = normalizeHex(meta.themeColor.trim()) || state.themeColor;
  state.startUrl = parsed.pathname || "/";
  if (meta.iconUrl) {
    try {
      await loadImageAsIcon(meta.iconUrl, true);
    } catch (e) {
      /* icon fetch is best-effort */
    }
  }
}

async function tryDirectFetch(url, parsed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const res = await fetch(url, { mode: "cors", signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) throw new Error("status " + res.status);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const titleEl = doc.querySelector("title");
  const descTag = doc.querySelector('meta[name="description"]');
  const themeTag = doc.querySelector('meta[name="theme-color"]');
  const iconTag =
    doc.querySelector('link[rel~="icon"]') ||
    doc.querySelector('link[rel="shortcut icon"]');
  let iconUrl = null;
  if (iconTag && iconTag.getAttribute("href")) {
    try {
      iconUrl = new URL(iconTag.getAttribute("href"), parsed.href).href;
    } catch (e) {}
  }
  await applyScannedMeta(
    {
      title: titleEl ? titleEl.textContent : null,
      description: descTag ? descTag.content : null,
      themeColor: themeTag ? themeTag.content : null,
      iconUrl,
    },
    parsed,
  );
  return true;
}

async function tryProxyFetch(url, parsed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let proxyUrl = CONFIG.PROXY_URL + "?url=" + encodeURIComponent(url);
  if (TURNSTILE_CONFIGURED && turnstileToken)
    proxyUrl += "&ts_token=" + encodeURIComponent(turnstileToken);
  const res = await fetch(proxyUrl, { signal: controller.signal });
  clearTimeout(timeout);
  if (!res.ok) throw new Error("proxy status " + res.status);
  const meta = await res.json();
  await applyScannedMeta(meta, parsed);
  return true;
}

function renderIdentity() {
  els.stepBody.innerHTML = `
    <div class="step-title">Identity</div>
    <p class="step-desc">This is what shows up on the home screen, in the app switcher, and on the splash screen.</p>
    <div class="field">
      <label for="fName">App name</label>
      <input type="text" id="fName" maxlength="45" value="${escapeHtml(state.name)}" placeholder="Northwind Coffee">
      <div class="char-count ${state.name.length > 45 ? "over" : ""}">${state.name.length}/45</div>
    </div>
    <div class="field">
      <label for="fShort">Short name <span style="font-weight:400;color:var(--ink-faint);">— shown under the home screen icon</span></label>
      <input type="text" id="fShort" maxlength="12" value="${escapeHtml(state.shortName)}" placeholder="Northwind">
      <div class="char-count ${state.shortName.length > 12 ? "over" : ""}">${state.shortName.length}/12</div>
    </div>
    <div class="field">
      <label for="fDesc">Description</label>
      <textarea id="fDesc" maxlength="300" placeholder="Order ahead and track rewards from your neighborhood coffee shop.">${escapeHtml(state.description)}</textarea>
      <div class="char-count ${state.description.length > 300 ? "over" : ""}">${state.description.length}/300</div>
    </div>
    <div class="field">
      <label for="fStart">Start URL</label>
      <input type="text" id="fStart" value="${escapeHtml(state.startUrl)}" placeholder="/">
      <div class="hint">The page that opens when someone launches the installed app. Use "/" for the homepage, or a path like "/app".</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="fTheme">Theme color <span style="font-weight:400;color:var(--ink-faint);">— toolbar &amp; status bar</span></label>
        <div class="color-field">
          <input type="color" id="fThemeColor" value="${state.themeColor}">
          <input type="text" id="fTheme" value="${state.themeColor}">
        </div>
      </div>
      <div class="field">
        <label for="fBg">Background color <span style="font-weight:400;color:var(--ink-faint);">— splash screen</span></label>
        <div class="color-field">
          <input type="color" id="fBgColor" value="${state.bgColor}">
          <input type="text" id="fBg" value="${state.bgColor}">
        </div>
      </div>
    </div>
    <div class="step-actions">
      <button class="btn-back" id="btnBack1">Back</button>
      <button class="btn-next" id="btnNext1">Continue</button>
    </div>
  `;
  document.getElementById("fName").oninput = (e) => {
    state.name = e.target.value;
    syncIdentityCounts();
    renderPreview();
  };
  document.getElementById("fShort").oninput = (e) => {
    state.shortName = e.target.value;
    syncIdentityCounts();
    renderPreview();
  };
  document.getElementById("fDesc").oninput = (e) => {
    state.description = e.target.value;
    syncIdentityCounts();
  };
  document.getElementById("fStart").oninput = (e) => {
    state.startUrl = e.target.value;
  };
  const syncColor = (colorId, textId, key) => {
    document.getElementById(colorId).oninput = (e) => {
      state[key] = e.target.value;
      document.getElementById(textId).value = e.target.value;
      renderPreview();
    };
    document.getElementById(textId).oninput = (e) => {
      const v = e.target.value;
      state[key] = v;
      if (normalizeHex(v)) document.getElementById(colorId).value = v;
      renderPreview();
    };
  };
  syncColor("fThemeColor", "fTheme", "themeColor");
  syncColor("fBgColor", "fBg", "bgColor");
  document.getElementById("btnBack1").onclick = prevStep;
  document.getElementById("btnNext1").onclick = nextStep;
}

function syncIdentityCounts() {
  const nameCount = els.stepBody.querySelectorAll(".char-count")[0];
  const shortCount = els.stepBody.querySelectorAll(".char-count")[1];
  const descCount = els.stepBody.querySelectorAll(".char-count")[2];
  if (nameCount) nameCount.textContent = state.name.length + "/45";
  if (shortCount) shortCount.textContent = state.shortName.length + "/12";
  if (descCount) descCount.textContent = state.description.length + "/300";
}

function renderIcon() {
  els.stepBody.innerHTML = `
    <div class="step-title">Icon</div>
    <p class="step-desc">Upload one square image, 512\u00d7512px or larger. We'll generate every size Android, iOS and desktop need, plus safe-zone maskable versions and iOS launch splash art.</p>
    <div class="dropzone" id="dropzone">
      <input type="file" id="fileInput" accept="image/png,image/jpeg,image/webp">
      <div class="icon-preview-wrap">
        ${state.iconDataUrl ? `<img class="icon-preview" src="${state.iconDataUrl}">` : `<div class="icon-preview" style="display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:11px;font-family:var(--mono);">no icon</div>`}
      </div>
      <div class="dropzone-title">${state.iconDataUrl ? "Replace icon" : "Drop an image here, or click to browse"}</div>
      <div class="dropzone-sub">PNG or JPG \u00b7 square \u00b7 512\u00d7512 or larger recommended</div>
    </div>
    <div id="iconWarning"></div>
    ${
      state.iconImg
        ? `
    <div class="mask-row">
      <div class="mask-item"><div class="mask-square"><img src="${state.iconDataUrl}"></div><div class="label">any / 192px</div></div>
      <div class="mask-item"><div class="mask-circle"><img src="${state.iconDataUrl}"></div><div class="label">maskable preview</div></div>
    </div>
    <div class="size-grid">
      ${ICON_SIZES.map((s) => `<span class="size-chip">${s}\u00d7${s}</span>`).join("")}
      <span class="size-chip">maskable 192</span><span class="size-chip">maskable 512</span>
      <span class="size-chip">favicon 32</span>
    </div>
    `
        : ""
    }
    <div class="step-actions">
      <button class="btn-back" id="btnBack2">Back</button>
      <button class="btn-next" id="btnNext2">Continue</button>
    </div>
  `;
  const dz = document.getElementById("dropzone");
  const fi = document.getElementById("fileInput");
  dz.onclick = () => fi.click();
  dz.ondragover = (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  };
  dz.ondragleave = () => dz.classList.remove("drag");
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0])
      handleIconFile(e.dataTransfer.files[0]);
  };
  fi.onchange = (e) => {
    if (e.target.files[0]) handleIconFile(e.target.files[0]);
  };
  document.getElementById("btnBack2").onclick = prevStep;
  document.getElementById("btnNext2").onclick = nextStep;
  renderIconWarning();
}

function renderIconWarning() {
  const box = document.getElementById("iconWarning");
  if (!box) return;
  box.innerHTML = state.iconWarning
    ? `<div class="status-line warn">${escapeHtml(state.iconWarning)}</div>`
    : "";
}

function handleIconFile(file) {
  if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
    state.iconWarning = "Unsupported file type. Use PNG, JPG or WebP.";
    renderIconWarning();
    return;
  }
  // 8MB client-side cap — keeps canvas work fast and avoids anyone dropping
  // an unreasonably large file into a browser-only image pipeline.
  if (file.size > 8 * 1024 * 1024) {
    state.iconWarning = "That file is larger than 8MB — use a smaller image.";
    renderIconWarning();
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => loadImageAsIcon(e.target.result, false);
  reader.readAsDataURL(file);
}

function loadImageAsIcon(src, silent) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      state.iconImg = img;
      state.iconDataUrl = src;
      if (img.width < 512 || img.height < 512) {
        state.iconWarning =
          "This image is " +
          img.width +
          "\u00d7" +
          img.height +
          "px. 512\u00d7512 or larger is recommended so nothing looks blurry at full size.";
      } else if (img.width !== img.height) {
        state.iconWarning =
          "This image isn't square (" +
          img.width +
          "\u00d7" +
          img.height +
          "). It will be center-cropped to a square.";
      } else {
        state.iconWarning = null;
      }
      if (!silent) renderStepBody();
      renderPreview();
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function renderBehavior() {
  els.stepBody.innerHTML = `
    <div class="step-title">Behavior</div>
    <p class="step-desc">How the installed app should look and how it should handle the network.</p>
    <div class="field">
      <label>Display mode</label>
      <div class="choice-grid" id="displayGrid"></div>
    </div>
    <div class="field">
      <label>Orientation</label>
      <div class="choice-grid" id="orientGrid" style="grid-template-columns:repeat(3,1fr);"></div>
    </div>
    <div class="field">
      <label>Caching strategy for the service worker</label>
      <div id="strategyList"></div>
    </div>
    <div class="step-actions">
      <button class="btn-back" id="btnBack3">Back</button>
      <button class="btn-next" id="btnNext3">Continue</button>
    </div>
  `;
  const dg = document.getElementById("displayGrid");
  DISPLAY_MODES.forEach((m) => {
    const c = document.createElement("div");
    c.className = "choice-card" + (state.display === m.v ? " selected" : "");
    c.innerHTML = `<div class="ct">${m.t}</div><div class="cd">${m.d}</div>`;
    c.onclick = () => {
      state.display = m.v;
      renderStepBody();
    };
    dg.appendChild(c);
  });
  const og = document.getElementById("orientGrid");
  ORIENTATIONS.forEach((o) => {
    const c = document.createElement("div");
    c.className =
      "choice-card" + (state.orientation === o.v ? " selected" : "");
    c.style.textAlign = "center";
    c.innerHTML = `<div class="ct">${o.t}</div>`;
    c.onclick = () => {
      state.orientation = o.v;
      renderStepBody();
    };
    og.appendChild(c);
  });
  const sl = document.getElementById("strategyList");
  STRATEGIES.forEach((s) => {
    const c = document.createElement("label");
    c.className = "radio-card" + (state.strategy === s.v ? " selected" : "");
    c.innerHTML = `<input type="radio" name="strategy" ${state.strategy === s.v ? "checked" : ""}>
      <div><div class="rt">${s.t}</div><div class="rd">${s.d}</div><div class="rcode">${s.code}</div></div>`;
    c.onclick = () => {
      state.strategy = s.v;
      renderStepBody();
    };
    sl.appendChild(c);
  });
  document.getElementById("btnBack3").onclick = prevStep;
  document.getElementById("btnNext3").onclick = nextStep;
}

let currentQualityScore = null;
// Turnstile widget state for the scan step. Only used when TURNSTILE_CONFIGURED
// is true (a real site key is set in CONFIG) — otherwise the widget never
// renders and turnstileToken stays null, which the proxy worker treats the
// same as "not configured" and skips verifying.
let turnstileWidgetId = null;
let turnstileToken = null;

function renderGenerate() {
  const strategy = STRATEGIES.find((s) => s.v === state.strategy);
  els.stepBody.innerHTML = `
    <div class="step-title">Generate</div>
    <p class="step-desc">Review your quality score, then build your files. Everything happens in your browser — nothing is uploaded anywhere.</p>
    <div class="score-panel" id="scorePanel"></div>
    <div class="summary-grid">
      <div class="summary-item"><div class="sl">Name</div><div class="sv">${escapeHtml(state.name || "\u2014")}</div></div>
      <div class="summary-item"><div class="sl">Short name</div><div class="sv">${escapeHtml(state.shortName || "\u2014")}</div></div>
      <div class="summary-item"><div class="sl">Display</div><div class="sv">${state.display}</div></div>
      <div class="summary-item"><div class="sl">Orientation</div><div class="sv">${state.orientation}</div></div>
      <div class="summary-item"><div class="sl">Caching strategy</div><div class="sv">${strategy.t}</div></div>
      <div class="summary-item"><div class="sl">Start URL</div><div class="sv">${escapeHtml(state.startUrl)}</div></div>
    </div>
    <div class="feature-toggles">
      <label class="toggle-chip ${state.includeSplash ? "on" : ""}" id="chipSplash"><input type="checkbox" ${state.includeSplash ? "checked" : ""}> iOS splash screens</label>
      <label class="toggle-chip ${state.includeFavicon ? "on" : ""}" id="chipFavicon"><input type="checkbox" ${state.includeFavicon ? "checked" : ""}> favicon.png</label>
      <label class="toggle-chip ${state.includeShortcuts ? "on" : ""}" id="chipShortcuts"><input type="checkbox" ${state.includeShortcuts ? "checked" : ""}> App shortcut entry</label>
    </div>
    <div class="generate-btn-row">
      <button class="btn-download" id="btnGenerate">Build &amp; download ZIP</button>
      <button class="btn-save-preset" id="btnSavePreset" ${auth.user ? "" : 'disabled title="Sign in to save presets"'}>Save these settings as a preset</button>
    </div>
    <div id="savePresetStatus"></div>
    <div class="progress-wrap" id="progressWrap" style="display:none;">
      <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-label" id="progressLabel">Preparing\u2026</div>
    </div>
    <div id="doneArea"></div>
    <div class="step-actions">
      <button class="btn-back" id="btnBack4">Back</button>
      <span></span>
    </div>
  `;
  currentQualityScore = renderScorePanel(document.getElementById("scorePanel"));
  document.getElementById("btnBack4").onclick = prevStep;
  document.getElementById("btnGenerate").onclick = runGenerate;
  const saveBtn = document.getElementById("btnSavePreset");
  if (saveBtn) saveBtn.onclick = saveCurrentAsPreset;
  document.getElementById("chipSplash").onclick = () => {
    state.includeSplash = !state.includeSplash;
    renderStepBody();
  };
  document.getElementById("chipFavicon").onclick = () => {
    state.includeFavicon = !state.includeFavicon;
    renderStepBody();
  };
  document.getElementById("chipShortcuts").onclick = () => {
    state.includeShortcuts = !state.includeShortcuts;
    renderStepBody();
  };
}

function setProgress(pct, label) {
  const wrap = document.getElementById("progressWrap");
  if (wrap) wrap.style.display = "block";
  const fill = document.getElementById("progressFill");
  const lbl = document.getElementById("progressLabel");
  if (fill) fill.style.width = pct + "%";
  if (lbl) lbl.textContent = label;
}

async function runGenerate() {
  const btn = document.getElementById("btnGenerate");
  btn.disabled = true;
  document.getElementById("doneArea").innerHTML = "";

  // Free-tier build cap only applies to signed-in accounts — there's no way
  // to enforce a per-browser limit for anonymous visitors, so this check is
  // skipped entirely when signed out (matches the "no account needed for a
  // single build" promise on the marketing page). consume_build_credit() is
  // the real enforcement (see supabase-schema.sql); it can't be bypassed by
  // calling the Supabase API directly the way a purely client-side check
  // could be.
  if (auth.user && supabaseClient && auth.plan === "free") {
    const { data: allowed, error } = await supabaseClient.rpc(
      "consume_build_credit",
    );
    if (error) {
      document.getElementById("doneArea").innerHTML =
        '<div class="err-list">Couldn\u2019t check your build allowance: ' +
        escapeHtml(error.message) +
        ". Try again.</div>";
      btn.disabled = false;
      return;
    }
    if (allowed === false) {
      document.getElementById("doneArea").innerHTML =
        '<div class="err-list">Free accounts get 1 build. <a href="#pricing">Upgrade to Studio</a> for unlimited builds.</div>';
      btn.disabled = false;
      return;
    }
    auth.buildsUsed += 1;
  }

  try {
    setProgress(6, "Building manifest.json\u2026");
    await tick();
    const manifest = buildManifest();

    setProgress(16, "Rendering icon sizes\u2026");
    await tick();
    const iconFiles = await generateIconFiles();

    setProgress(38, "Rendering maskable icons\u2026");
    await tick();
    const maskableFiles = await generateMaskableFiles();

    setProgress(52, "Rendering iOS splash screens\u2026");
    await tick();
    const splashFiles = await generateSplashFiles();

    setProgress(64, "Rendering favicon\u2026");
    await tick();
    const faviconFile = await generateFaviconFile();

    setProgress(74, "Writing service worker\u2026");
    await tick();
    const sw = buildServiceWorker();
    const offline = buildOfflinePage();
    const headSnippet = buildHeadSnippet();
    const registerScript = buildRegisterScript();
    const scoreNow = computeQualityScore();
    const readme = buildReadme(scoreNow);

    setProgress(88, "Packing ZIP\u2026");
    await tick();
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("sw.js", sw);
    zip.file("offline.html", offline);
    zip.file("register-sw.js", registerScript);
    zip.file("head-snippet.html", headSnippet);
    zip.file("README.txt", readme);
    const iconFolder = zip.folder("icons");
    iconFiles.forEach((f) => iconFolder.file(f.name, f.blob));
    maskableFiles.forEach((f) => iconFolder.file(f.name, f.blob));
    splashFiles.forEach((f) => iconFolder.file(f.name, f.blob));
    if (faviconFile) iconFolder.file(faviconFile.name, faviconFile.blob);

    const blob = await zip.generateAsync({ type: "blob" });

    setProgress(100, "Done.");
    await tick();

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (state.shortName || "pwafy-app")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") + "-pwa.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();

    const allFiles = iconFiles.concat(maskableFiles).concat(splashFiles);
    if (faviconFile) allFiles.push(faviconFile);
    renderFileListSidebar(allFiles);
    renderDoneArea(headSnippet, registerScript);
  } catch (err) {
    setProgress(100, "Something went wrong.");
    document.getElementById("doneArea").innerHTML =
      '<div class="err-list">Build failed: ' +
      escapeHtml(err.message || String(err)) +
      ". Nothing was uploaded — try generating again.</div>";
  } finally {
    btn.disabled = false;
  }
}

function renderFileListSidebar(iconFiles) {
  const rows = [
    { n: "manifest.json" },
    { n: "sw.js" },
    { n: "offline.html" },
    { n: "register-sw.js" },
    { n: "head-snippet.html" },
    { n: "README.txt" },
  ]
    .map(
      (f) =>
        `<div class="frow"><span class="fname">${f.n}</span><span class="fsize"></span></div>`,
    )
    .join("");
  const iconRows = iconFiles
    .map(
      (f) =>
        `<div class="frow"><span class="fname">icons/${f.name}</span><span class="fsize">${(f.size / 1024).toFixed(1)}kb</span></div>`,
    )
    .join("");
  els.fileList.innerHTML = rows + iconRows;
}

function renderDoneArea(headSnippet, registerScript) {
  const area = document.getElementById("doneArea");
  area.innerHTML = `
    <div class="done-banner">Your ZIP has downloaded. Drop the contents into your site's root folder.</div>
    <div class="code-tabs">
      <button class="active" data-t="head">head-snippet.html</button>
      <button data-t="reg">register-sw.js</button>
    </div>
    <div class="code-box"><pre id="codePre"></pre></div>
    <button class="copy-btn" id="copyCode">Copy this snippet</button>
  `;
  const pre = document.getElementById("codePre");
  let current = headSnippet;
  pre.textContent = current;
  area.querySelectorAll(".code-tabs button").forEach((b) => {
    b.onclick = () => {
      area
        .querySelectorAll(".code-tabs button")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      current = b.dataset.t === "head" ? headSnippet : registerScript;
      pre.textContent = current;
    };
  });
  document.getElementById("copyCode").onclick = () => {
    navigator.clipboard.writeText(current).then(() => {
      const btn = document.getElementById("copyCode");
      const orig = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = orig), 1400);
    });
  };
}

function renderAll() {
  renderStepsNav();
  renderStepBody();
  renderPreview();
}
