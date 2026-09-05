/* ===========================================================
   PWAfy — app.js
   Boot sequence, theme toggle, and wiring for everything outside
   the wizard (nav, modals, pricing).
   Built by AYOCODES
   =========================================================== */

<<<<<<< HEAD
(function () {
=======
(function(){
>>>>>>> origin/main
  "use strict";

  /* ---------------- Boot preloader ---------------- */
  const BOOT_LINES = [
<<<<<<< HEAD
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
=======
    'warming up the generator\u2026',
    'checking manifest spec\u2026',
    'loading icon pipeline\u2026',
    'ready.'
  ];
  function runBootSequence(){
    const line = document.getElementById('bootLine');
    const fill = document.getElementById('bootFill');
    const pre = document.getElementById('bootPreloader');
    let i = 0;
    const step = () => {
      if(line) line.textContent = BOOT_LINES[i];
      if(fill) fill.style.width = Math.round(((i+1)/BOOT_LINES.length) * 100) + '%';
      i++;
      if(i < BOOT_LINES.length){ setTimeout(step, 260); }
      else{ setTimeout(() => { if(pre) pre.classList.add('hidden'); }, 260); }
>>>>>>> origin/main
    };
    step();
  }

  /* ---------------- Theme ---------------- */
<<<<<<< HEAD
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
=======
  function initTheme(){
    const saved = localStorage.getItem('pwafy_theme');
    const preferred = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if(preferred === 'dark') document.documentElement.setAttribute('data-theme','dark');
    document.getElementById('themeToggle').onclick = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if(isDark){ document.documentElement.removeAttribute('data-theme'); localStorage.setItem('pwafy_theme','light'); }
      else{ document.documentElement.setAttribute('data-theme','dark'); localStorage.setItem('pwafy_theme','dark'); }
>>>>>>> origin/main
    };
  }

  /* ---------------- Nav / hero wiring ---------------- */
<<<<<<< HEAD
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

  /* ---------------- Auth modal wiring ---------------- */
  function initAuthModalControls() {
    document.getElementById("btnCloseAuth").onclick = closeAuthModal;
    document.getElementById("btnSendLink").onclick = sendMagicLink;
    document.getElementById("authModal").addEventListener("click", (e) => {
      if (e.target.id === "authModal") closeAuthModal();
=======
  function initNav(){
    document.getElementById('btnOpenTool').onclick = () => document.getElementById('tool').scrollIntoView({behavior:'smooth'});
    document.getElementById('btnHeroStart').onclick = () => document.getElementById('tool').scrollIntoView({behavior:'smooth'});
    document.getElementById('btnHeroHow').onclick = () => document.getElementById('how').scrollIntoView({behavior:'smooth'});
    document.getElementById('btnStartFree').onclick = () => document.getElementById('tool').scrollIntoView({behavior:'smooth'});
  }

  /* ---------------- Auth modal wiring ---------------- */
  function initAuthModalControls(){
    document.getElementById('btnCloseAuth').onclick = closeAuthModal;
    document.getElementById('btnSendLink').onclick = sendMagicLink;
    document.getElementById('authModal').addEventListener('click', e => {
      if(e.target.id === 'authModal') closeAuthModal();
>>>>>>> origin/main
    });
  }

  /* ---------------- Transfer modal wiring ---------------- */
<<<<<<< HEAD
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
=======
  function initTransferModalControls(){
    document.getElementById('btnCloseTransfer').onclick = closeTransferModal;
    document.getElementById('transferModal').addEventListener('click', e => {
      if(e.target.id === 'transferModal') closeTransferModal();
    });
  }

  /* ---------------- Pricing wiring ---------------- */
  function initPricing(){
    document.getElementById('currencySelect').onchange = e => {
      selectedCurrency = e.target.value;
      updatePricingDisplay();
    };
    document.getElementById('btnUpgradeStudio').onclick = () => startCardCheckout('studio');
    document.getElementById('btnUpgradeAgency').onclick = () => startCardCheckout('agency');
    document.getElementById('btnTransferStudio').onclick = () => startTransferCheckout('studio');
    document.getElementById('btnTransferAgency').onclick = () => startTransferCheckout('agency');
    updatePricingDisplay();
  }

  /* ---------------- Preview toggle wiring ---------------- */
  function initPreviewToggle(){
    document.querySelectorAll('#previewToggle button').forEach(b => {
      b.onclick = () => setPhoneView(b.dataset.view);
    });
  }

  /* ---------------- Init ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
>>>>>>> origin/main
    runBootSequence();
    initTheme();
    cacheEls();
    renderAll();
    initNav();
    initAuthModalControls();
    initTransferModalControls();
<<<<<<< HEAD
    initTeamModalControls();
=======
    initPreviewToggle();
>>>>>>> origin/main
    initPricing();
    renderAccountBar();
    initAuth();
  });
})();
