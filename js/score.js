/* ===========================================================
   PWAfy, score.js
   A plain-language quality score, computed from wizard state.
   Mirrors the checks browsers actually use to decide whether a
   site is installable, so the score means something real.
   Built by AYOCODES
   =========================================================== */

function computeQualityScore() {
  const checks = [];

  const push = (pass, weight, label) => checks.push({ pass, weight, label });

  push(!!state.name.trim(), 15, "App name is set");
  push(
    !!state.shortName.trim() && state.shortName.length <= 12,
    10,
    "Short name fits the 12-character home screen limit",
  );
  push(
    !!state.description.trim(),
    8,
    "Description is filled in (helps install prompts and app stores)",
  );
  push(!!state.startUrl.trim(), 10, "Start URL is set");
  push(!!normalizeHex(state.themeColor), 8, "Theme color is valid");
  push(!!normalizeHex(state.bgColor), 8, "Background color is valid");
  push(!!state.iconImg, 15, "Source icon uploaded");
  push(
    !!state.iconImg &&
      state.iconImg.width >= 512 &&
      state.iconImg.height >= 512,
    10,
    "Icon is 512\u00d7512 or larger (required for maskable + splash quality)",
  );
  push(
    !!state.iconImg && state.iconImg.width === state.iconImg.height,
    6,
    "Icon is square (no cropping needed)",
  );
  push(state.includeSplash, 5, "iOS splash screens included");
  push(state.includeFavicon, 3, "favicon.png included");
  push(!!state.strategy, 2, "Service worker caching strategy chosen");

  const maxScore = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const total = Math.round((earned / maxScore) * 100);

  return { total, checks };
}

function scoreRingSvg(total) {
  const r = 30,
    circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - total / 100);
  const color =
    total >= 85
      ? "var(--success)"
      : total >= 60
        ? "var(--warn)"
        : "var(--danger)";
  return `
    <div class="score-ring">
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle class="bg" cx="38" cy="38" r="${r}"></circle>
        <circle class="fg" cx="38" cy="38" r="${r}" stroke="${color}"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
      </svg>
      <div class="num">${total}</div>
    </div>
  `;
}

function renderScorePanel(containerEl) {
  const { total, checks } = computeQualityScore();
  containerEl.innerHTML = `
    ${scoreRingSvg(total)}
    <div class="score-checklist">
      ${checks.map((c) => `<div class="score-row ${c.pass ? "pass" : "fail"}">${escapeHtml(c.label)}</div>`).join("")}
    </div>
  `;
  return total;
}
