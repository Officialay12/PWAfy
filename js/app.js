/* ===========================================================
   PWAfy, app.js
   Boot sequence, theme toggle, and wiring for everything outside
   the wizard (nav, modals, pricing).
   Built by AYOCODES
   =========================================================== */

(function () {
  "use strict";

  /* ---------------- Boot preloader ---------------- */
  const BOOT_LINES = [
    "warming up the generator\u2026",
    "checking manifest spec\u2026",
    "loading icon pipeline\u2026",
    "ready.",
  ];
  function runBootSequence() {
    const line = document.getElementById("bootLine");
    const fill = document.getElementById("bootFill");
    const pre = document.getElementById("bootPreloader");
    let i = 0;
    const step = () => {
      if (line) line.textContent = BOOT_LINES[i];
      if (fill)
        fill.style.width =
          Math.round(((i + 1) / BOOT_LINES.length) * 100) + "%";
      i++;
      if (i < BOOT_LINES.length) {
        setTimeout(step, 260);
      } else {
        setTimeout(() => {
          if (pre) pre.classList.add("hidden");
        }, 260);
      }
    };
    step();
  }

  /* ---------------- Theme ---------------- */
  function initTheme() {
    const saved = localStorage.getItem("pwafy_theme");
    const preferred =
      saved ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    if (preferred === "dark")
      document.documentElement.setAttribute("data-theme", "dark");
    document.getElementById("themeToggle").onclick = () => {
      const isDark =
        document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        localStorage.setItem("pwafy_theme", "light");
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("pwafy_theme", "dark");
      }
    };
  }

  /* ---------------- Nav / hero wiring ---------------- */
  function initNav() {
    document.getElementById("btnOpenTool").onclick = () =>
      document.getElementById("tool").scrollIntoView({ behavior: "smooth" });
    document.getElementById("btnHeroStart").onclick = () =>
      document.getElementById("tool").scrollIntoView({ behavior: "smooth" });
    document.getElementById("btnHeroHow").onclick = () =>
      document.getElementById("how").scrollIntoView({ behavior: "smooth" });
    document.getElementById("btnStartFree").onclick = () =>
      document.getElementById("tool").scrollIntoView({ behavior: "smooth" });
  }

  /* ---------------- Mobile nav menu ---------------- */
  // The mobile dropdown mirrors the account slot and "Open the builder"
  // action rather than duplicating markup, so renderAccountBar() only ever
  // has to write to one bar of truth (accountSlot) and this just clones it.
  function closeNavMenu() {
    const nav = document.getElementById("mainNav");
    nav.classList.remove("menu-open");
    document
      .getElementById("btnNavMenu")
      .setAttribute("aria-expanded", "false");
    document.getElementById("navMenuIcon").innerHTML = "&#9776;";
  }

  function initMobileNav() {
    const nav = document.getElementById("mainNav");
    const btn = document.getElementById("btnNavMenu");
    const icon = document.getElementById("navMenuIcon");
    btn.onclick = () => {
      const open = nav.classList.toggle("menu-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      icon.innerHTML = open ? "&#10005;" : "&#9776;";
      if (open) syncMobileAccountSlot();
    };
    document.getElementById("btnOpenToolMobile").onclick = () => {
      closeNavMenu();
      document.getElementById("tool").scrollIntoView({ behavior: "smooth" });
    };
    document.getElementById("themeToggleMobile").onclick = () =>
      document.getElementById("themeToggle").click();
    document.addEventListener("click", (e) => {
      if (!nav.classList.contains("menu-open")) return;
      if (nav.contains(e.target)) return;
      closeNavMenu();
    });
  }

  // Keeps the mobile panel's account slot showing the same sign-in state as
  // the desktop one, without renderAccountBar() needing to know about the
  // mobile panel at all.
  function syncMobileAccountSlot() {
    const desktopSlot = document.getElementById("accountSlot");
    const mobileSlot = document.getElementById("accountSlotMobile");
    if (!desktopSlot || !mobileSlot) return;
    mobileSlot.innerHTML = desktopSlot.innerHTML;
    mobileSlot.querySelectorAll("button, a").forEach((el, i) => {
      const original = desktopSlot.querySelectorAll("button, a")[i];
      if (original)
        el.onclick = () => {
          closeNavMenu();
          original.click();
        };
    });
  }
  window.syncMobileAccountSlot = syncMobileAccountSlot;

  /* ---------------- Auth modal wiring ---------------- */
  function initAuthModalControls() {
    document.getElementById("btnCloseAuth").onclick = closeAuthModal;
    document.getElementById("btnSendLink").onclick = sendMagicLink;
    document.getElementById("authModal").addEventListener("click", (e) => {
      if (e.target.id === "authModal") closeAuthModal();
    });
  }

  /* ---------------- Transfer modal wiring ---------------- */
  function initTransferModalControls() {
    document.getElementById("btnCloseTransfer").onclick = closeTransferModal;
    document.getElementById("transferModal").addEventListener("click", (e) => {
      if (e.target.id === "transferModal") closeTransferModal();
    });
  }

  /* ---------------- Team modal wiring ---------------- */
  function initTeamModalControls() {
    const closeBtn = document.getElementById("btnCloseTeam");
    if (closeBtn) closeBtn.onclick = closeTeamModal;
    const modal = document.getElementById("teamModal");
    if (modal)
      modal.addEventListener("click", (e) => {
        if (e.target.id === "teamModal") closeTeamModal();
      });
  }

  /* ---------------- Pricing wiring ---------------- */
  function initPricing() {
    document.getElementById("currencySelect").onchange = (e) => {
      selectedCurrency = e.target.value;
      updatePricingDisplay();
    };
    document.getElementById("btnUpgradeStudio").onclick = () =>
      startCardCheckout("studio");
    document.getElementById("btnUpgradeAgency").onclick = () =>
      startCardCheckout("agency");
    document.getElementById("btnTransferStudio").onclick = () =>
      startTransferCheckout("studio");
    document.getElementById("btnTransferAgency").onclick = () =>
      startTransferCheckout("agency");
    updatePricingDisplay();
  }

  /* ---------------- Init ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    runBootSequence();
    initTheme();
    cacheEls();
    renderAll();
    initNav();
    initMobileNav();
    initAuthModalControls();
    initTransferModalControls();
    initTeamModalControls();
    initNameModalControls();
    initPricing();
    renderAccountBar();
    initAuth();
    initAssistant();
  });
})();
