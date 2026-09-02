/* ===========================================================
   PWAfy — preview.js
   Renders the phone/desktop preview column so people can see
   exactly what an install looks like before they download anything.
   Built by AYOCODES
   =========================================================== */

function setPhoneView(v){
  state.phoneView = v;
  document.querySelectorAll('#previewToggle button').forEach(b => b.classList.toggle('active', b.dataset.view===v));
  renderPreview();
}

function renderPreview(){
  const home = document.getElementById('phoneIcon');
  const name = document.getElementById('phoneName');
  const splash = document.getElementById('phoneSplash');
  const screen = document.getElementById('phoneScreen');
  const installBanner = document.getElementById('installBanner');

  name.textContent = state.shortName || state.name || 'Your app';
  splash.style.display = 'none';
  installBanner.style.display = 'none';
  home.style.display = 'none';
  name.style.display = 'none';

  if(state.phoneView === 'home'){
    home.style.display = state.iconDataUrl ? 'block' : 'none';
    name.style.display = 'block';
    if(state.iconDataUrl) home.src = state.iconDataUrl;
    screen.style.background = 'linear-gradient(160deg,var(--paper-raised),var(--paper))';
  } else if(state.phoneView === 'splash'){
    splash.style.display = 'flex';
    screen.style.background = state.bgColor;
    splash.innerHTML = (state.iconDataUrl ? `<img src="${state.iconDataUrl}">` : '') +
      `<div class="sname" style="color:${contrastColor(state.bgColor)}">${escapeHtml(state.name || 'Your app')}</div>`;
  } else if(state.phoneView === 'install'){
    home.style.display = state.iconDataUrl ? 'block' : 'none';
    if(state.iconDataUrl) home.src = state.iconDataUrl;
    name.style.display = 'block';
    screen.style.background = 'linear-gradient(160deg,var(--paper-raised),var(--paper))';
    installBanner.style.display = 'flex';
    document.getElementById('ibName').textContent = state.name || 'Your app';
    const ibIcon = document.getElementById('ibIcon');
    if(state.iconDataUrl) ibIcon.src = state.iconDataUrl;
  }
}
