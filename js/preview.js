/* ===========================================================
   PWAfy, preview.js
   Renders the phone/desktop preview column so people can see
   exactly what an install looks like before they download anything.
   Built by AYOCODES
   =========================================================== */

const DEVICE_VIEWS = {
  phone: [
    { v: "home", t: "Home screen" },
    { v: "app", t: "App open" },
    { v: "splash", t: "Splash" },
    { v: "install", t: "Install prompt" },
  ],
  desktop: [
    { v: "browser", t: "Before install" },
    { v: "installed", t: "Installed" },
  ],
};

function setPreviewDevice(d) {
  state.previewDevice = d;
  // Reset to that device's first view whenever the current one doesn't apply
  // (e.g. switching from phone's "splash" to desktop, which has no splash view).
  const valid = DEVICE_VIEWS[d].map((x) => x.v);
  if (!valid.includes(state.phoneView)) state.phoneView = valid[0];
  renderPreview();
}

function setPhoneView(v) {
  state.phoneView = v;
  renderPreview();
}

function setPreviewPlatform(p) {
  state.previewPlatform = p;
  renderPreview();
}

function renderDeviceToggle() {
  const box = document.getElementById("deviceToggle");
  if (!box) return;
  box.innerHTML = ["phone", "desktop"]
    .map(
      (d) =>
        `<button class="${state.previewDevice === d ? "active" : ""}" data-device="${d}">${d === "phone" ? "Phone" : "Desktop"}</button>`,
    )
    .join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => setPreviewDevice(b.dataset.device);
  });
}

function renderViewToggle() {
  const box = document.getElementById("previewToggle");
  if (!box) return;
  box.innerHTML = DEVICE_VIEWS[state.previewDevice]
    .map(
      (o) =>
        `<button class="${state.phoneView === o.v ? "active" : ""}" data-view="${o.v}">${o.t}</button>`,
    )
    .join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => setPhoneView(b.dataset.view);
  });
}

function renderPlatformToggle() {
  const box = document.getElementById("platformToggle");
  if (!box) return;
  const show = state.previewDevice === "phone" && state.phoneView === "install";
  box.style.display = show ? "flex" : "none";
  if (!show) return;
  box.innerHTML = ["android", "ios"]
    .map(
      (p) =>
        `<button class="${state.previewPlatform === p ? "active" : ""}" data-platform="${p}">${p === "android" ? "Android" : "iOS"}</button>`,
    )
    .join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => setPreviewPlatform(b.dataset.platform);
  });
}

function renderPreview() {
  renderDeviceToggle();
  renderViewToggle();
  renderPlatformToggle();

  const phoneShell = document.getElementById("phoneShell");
  const desktopShell = document.getElementById("desktopShell");
  if (state.previewDevice === "phone") {
    phoneShell.style.display = "";
    desktopShell.style.display = "none";
    renderPhonePreview();
  } else {
    phoneShell.style.display = "none";
    desktopShell.style.display = "";
    renderDesktopPreview();
  }
}

function renderPhonePreview() {
  const home = document.getElementById("phoneIcon");
  const name = document.getElementById("phoneName");
  const splash = document.getElementById("phoneSplash");
  const screen = document.getElementById("phoneScreen");
  const installBanner = document.getElementById("installBanner");
  const appOpen = document.getElementById("phoneAppOpen");
  const shareSheet = document.getElementById("iosShareSheet");

  name.textContent = state.shortName || state.name || "Your app";
  splash.style.display = "none";
  installBanner.style.display = "none";
  shareSheet.style.display = "none";
  appOpen.style.display = "none";
  home.style.display = "none";
  name.style.display = "none";
  screen.style.background =
    "linear-gradient(160deg,var(--paper-raised),var(--paper))";

  if (state.phoneView === "home") {
    home.style.display = state.iconDataUrl ? "block" : "none";
    name.style.display = "block";
    if (state.iconDataUrl) home.src = state.iconDataUrl;
  } else if (state.phoneView === "app") {
    appOpen.style.display = "flex";
    const header = document.getElementById("appOpenHeader");
    const body = document.getElementById("appOpenBody");
    const theme = normalizeHex(state.themeColor) || "#1E6E4C";
    const bg = normalizeHex(state.bgColor) || "#EDEFEA";
    header.style.background = theme;
    header.style.color = contrastColor(theme);
    header.textContent = state.name || "Your app";
    body.style.background = bg;
    body.innerHTML = `
      <div class="mock-line" style="background:${contrastColor(bg)};opacity:.14;width:70%"></div>
      <div class="mock-line" style="background:${contrastColor(bg)};opacity:.14;width:88%"></div>
      <div class="mock-line" style="background:${contrastColor(bg)};opacity:.14;width:55%"></div>
    `;
  } else if (state.phoneView === "splash") {
    splash.style.display = "flex";
    screen.style.background = state.bgColor;
    splash.innerHTML =
      (state.iconDataUrl ? `<img src="${state.iconDataUrl}">` : "") +
      `<div class="sname" style="color:${contrastColor(state.bgColor)}">${escapeHtml(state.name || "Your app")}</div>`;
  } else if (state.phoneView === "install") {
    home.style.display = state.iconDataUrl ? "block" : "none";
    if (state.iconDataUrl) home.src = state.iconDataUrl;
    name.style.display = "block";
    if (state.previewPlatform === "android") {
      installBanner.style.display = "flex";
      document.getElementById("ibName").textContent = state.name || "Your app";
      document.getElementById("ibSub").textContent = "Add to Home screen";
      document.getElementById("ibBtn").textContent = "Install";
      const ibIcon = document.getElementById("ibIcon");
      if (state.iconDataUrl) ibIcon.src = state.iconDataUrl;
    } else {
      // iOS Safari has no native install prompt, this is the real flow:
      // Share sheet -> Add to Home Screen. Showing this matters because
      // most people building a PWA don't realize iOS works completely
      // differently from Android here.
      shareSheet.style.display = "flex";
    }
  }
}

function renderDesktopPreview() {
  const addr = document.getElementById("desktopAddr");
  const installIcon = document.getElementById("desktopInstallIcon");
  const content = document.getElementById("desktopContent");
  const taskbar = document.getElementById("desktopTaskbar");
  const taskbarIcon = document.getElementById("desktopTaskbarIcon");
  const taskbarName = document.getElementById("desktopTaskbarName");
  const chrome = document.querySelector(".browser-chrome");

  const url = (state.startUrl || "/").replace(/^\//, "");
  addr.textContent = url ? "yoursite.com/" + url : "yoursite.com";
  const theme = normalizeHex(state.themeColor) || "#1E6E4C";
  const bg = normalizeHex(state.bgColor) || "#EDEFEA";

  content.innerHTML = `
    <div class="mock-topbar" style="background:${theme};color:${contrastColor(theme)}">${escapeHtml(state.name || "Your app")}</div>
    <div class="mock-body" style="background:${bg}">
      <div class="mock-line" style="background:${contrastColor(bg)};opacity:.14;width:60%"></div>
      <div class="mock-line" style="background:${contrastColor(bg)};opacity:.14;width:80%"></div>
    </div>
  `;

  if (state.phoneView === "installed") {
    // An installed PWA opens in its own window, no tabs, no full address
    // bar, just a minimal title bar, and gets pinned to the taskbar/dock.
    chrome.classList.add("installed");
    installIcon.style.display = "none";
    taskbar.style.display = "flex";
    taskbarName.textContent = state.shortName || state.name || "Your app";
    if (state.iconDataUrl) taskbarIcon.src = state.iconDataUrl;
  } else {
    chrome.classList.remove("installed");
    installIcon.style.display = "inline-flex";
    taskbar.style.display = "none";
  }
}
