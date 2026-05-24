// theme.js — Wonga Cup theme switcher + Tweaks edit-mode protocol

(function () {
  const TWEAK_DEFAULS = /*EDITMODE-BEGIN*/{
    "theme": "green",
    "mode": "light"
  }/*EDITMODE-END*/;

  const html = document.documentElement;
  const panel = document.getElementById('theme-switcher');

  // ── apply state to <html> + button highlights
  function apply(state) {
    html.setAttribute('data-theme', state.theme || 'green');
    html.setAttribute('data-mode', state.mode || 'light');
    if (!panel) return;
    panel.querySelectorAll('button[data-theme]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-theme') === state.theme);
    });
    panel.querySelectorAll('button[data-mode]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-mode') === state.mode);
    });
  }

  let state = { ...TWEAK_DEFAULS };
  apply(state);

  // Persist to host so a refresh keeps the choice
  function persist(edits) {
    state = { ...state, ...edits };
    apply(state);
    try {
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*');
    } catch (_) {}
  }

  // Wire up button clicks
  if (panel) {
    panel.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.theme) persist({ theme: t.dataset.theme });
      if (t.dataset.mode)  persist({ mode: t.dataset.mode });
    });
  }

  // ── Tweaks (edit-mode) protocol
  // Register listener BEFORE announcing availability.
  window.addEventListener('message', (e) => {
    const t = e?.data?.type;
    if (t === '__activate_edit_mode' && panel) {
      panel.hidden = false;
    } else if (t === '__deactivate_edit_mode' && panel) {
      panel.hidden = true;
    }
  });
  try {
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
  } catch (_) {}
})();
