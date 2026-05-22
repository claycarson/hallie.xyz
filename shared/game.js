/* ============================================================
   HALLIE.XYZ — Shared Game Utilities
   Load in every game: <script src="../shared/game.js"></script>
   (Hub page uses:     <script src="shared/game.js"></script>)

   Exposes a global `Hallie` object with:
     Hallie.addSession(n)         — add/subtract session tokens, updates #token-count
     Hallie.getSession()          — current session token count
     Hallie.getLifetime()         — all-time tokens earned (from localStorage)
     Hallie.confetti()            — launch confetti (requires #confetti-layer in HTML)
     Hallie.flashMessage(text, ms)— show a brief centered message (requires #flash-msg in HTML)
     Hallie.initSecretTap(el)     — wire up 5-tap secret on element (requires
                                    #secret-modal, #lifetime-val, #sm-close in HTML)
   ============================================================ */

const Hallie = (() => {
  const STORE_KEY = 'hallie_lifetime_tokens';
  let _session = 0;
  let _taps = [];

  function getLifetime() {
    return parseInt(localStorage.getItem(STORE_KEY) || '0', 10);
  }

  function getSession() {
    return _session;
  }

  function addSession(n) {
    _session = Math.max(0, _session + n);
    if (n > 0) {
      localStorage.setItem(STORE_KEY, getLifetime() + n);
    }
    const el = document.getElementById('token-count');
    if (el) el.textContent = _session;
  }

  function confetti() {
    const layer = document.getElementById('confetti-layer');
    if (!layer) return;
    layer.style.display = 'block';
    layer.innerHTML = '';
    const colors = ['#ff6b6b','#ffd700','#4cff8c','#64c8ff','#ff9ff3','#ff9900','#a29bfe'];
    for (let i = 0; i < 70; i++) {
      const el = document.createElement('div');
      el.className = 'conf';
      const size = 7 + Math.random() * 9;
      el.style.cssText =
        `left:${Math.random()*100}vw;` +
        `width:${size}px;height:${size}px;` +
        `background:${colors[Math.floor(Math.random()*colors.length)]};` +
        `border-radius:${Math.random() > 0.5 ? '50%' : '3px'};` +
        `animation-duration:${1.4 + Math.random()*2.2}s;` +
        `animation-delay:${Math.random()*0.6}s;`;
      layer.appendChild(el);
    }
    setTimeout(() => { layer.style.display = 'none'; layer.innerHTML = ''; }, 4500);
  }

  function initSecretTap(tapTarget) {
    tapTarget.addEventListener('click', () => {
      const now = Date.now();
      _taps = _taps.filter(t => now - t < 2500);
      _taps.push(now);
      if (_taps.length >= 5) {
        _taps = [];
        const modal = document.getElementById('secret-modal');
        const val   = document.getElementById('lifetime-val');
        if (modal && val) {
          val.textContent = getLifetime();
          modal.classList.add('show');
        }
      }
    });
    document.getElementById('sm-close')?.addEventListener('click', () => {
      document.getElementById('secret-modal')?.classList.remove('show');
    });
  }

  function flashMessage(text, ms = 1200) {
    const el = document.getElementById('flash-msg');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), ms);
  }

  return { addSession, getSession, getLifetime, confetti, flashMessage, initSecretTap };
})();
