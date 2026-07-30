// theme.js — Wonga Cup theme switcher + Tweaks edit-mode protocol

(function () {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "theme": "green",
    "mode": "light"
  }/*EDITMODE-END*/;

  const STORAGE_KEY = 'wongaCup2026_theme';
  const html = document.documentElement;
  const panel = document.getElementById('theme-switcher');

  function readStoredState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  // Reads the theme's actual canvas colour back out of styles.css (the
  // [data-theme][data-mode] rules) rather than duplicating that palette
  // here -- one source of truth, and it covers every theme automatically.
  function computedCanvasColor() {
    try {
      const value = getComputedStyle(html).getPropertyValue('--canvas').trim();
      return value || null;
    } catch (_) {
      return null;
    }
  }

  // ── apply state to <html> + button highlights, optionally syncing meta
  function apply(state, { syncMeta = false } = {}) {
    html.setAttribute('data-theme', state.theme || 'green');
    html.setAttribute('data-mode', state.mode || 'light');

    // Only touch the meta tags once a real override is in play (a stored
    // choice was restored, or the visitor just changed it) -- an untouched
    // default load leaves each page's own hand-picked meta values alone.
    if (syncMeta) {
      const colorScheme = document.querySelector('meta[name="color-scheme"]');
      if (colorScheme) colorScheme.setAttribute('content', state.mode || 'light');
      const canvas = computedCanvasColor();
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta && canvas) themeColorMeta.setAttribute('content', canvas);
    }

    if (!panel) return;
    panel.querySelectorAll('button[data-theme]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-theme') === state.theme);
    });
    panel.querySelectorAll('button[data-mode]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-mode') === state.mode);
    });
  }

  // Stored choice (real visitor, persisted via localStorage) takes
  // precedence over the edit-mode defaults baked into the page.
  const storedState = readStoredState();
  let state = { ...TWEAK_DEFAULTS, ...(storedState || {}) };
  apply(state, { syncMeta: Boolean(storedState) });

  // Persist both to the edit-mode host (if one is listening) and to
  // localStorage (so a normal visitor's choice survives navigation/refresh
  // even with no host present).
  function persist(edits) {
    state = { ...state, ...edits };
    apply(state, { syncMeta: true });
    writeStoredState(state);
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
