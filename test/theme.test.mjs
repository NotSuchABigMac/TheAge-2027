import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THEME_PATH = require.resolve('../theme.js');

// theme.js is an IIFE with no exports -- it reads globals `document` and
// `window` at load time. No jsdom, no dependencies: a small hand-rolled
// stub is enough to exercise its actual behavior (issue #165).
function classListStub() {
  const set = new Set();
  return {
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    contains(name) { return set.has(name); },
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : force;
      if (on) set.add(name); else set.delete(name);
      return on;
    }
  };
}

// kind is 'theme' or 'mode' -- mirrors how a real <button data-theme="claret">
// exposes both dataset.theme and getAttribute('data-theme').
function buttonStub(kind, value) {
  const self = {
    dataset: { [kind]: value },
    getAttribute: (name) => (name === `data-${kind}` ? value : null),
    classList: classListStub(),
    closest: () => self
  };
  return self;
}

function loadTheme({ withPanel = true } = {}) {
  const html = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };

  const themeButtons = [buttonStub('theme', 'green'), buttonStub('theme', 'claret'), buttonStub('theme', 'navy')];
  const modeButtons = [buttonStub('mode', 'light'), buttonStub('mode', 'dark')];

  const panel = withPanel ? {
    hidden: true,
    listeners: {},
    addEventListener(t, fn) { this.listeners[t] = fn; },
    querySelectorAll(sel) {
      if (sel === 'button[data-theme]') return themeButtons;
      if (sel === 'button[data-mode]') return modeButtons;
      return [];
    }
  } : null;

  const documentStub = {
    documentElement: html,
    getElementById: (id) => (withPanel && id === 'theme-switcher' ? panel : null)
  };

  const windowStub = {
    listeners: {},
    addEventListener(t, fn) { this.listeners[t] = fn; },
    parent: { posted: [], postMessage(msg) { this.posted.push(msg); } }
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  delete require.cache[THEME_PATH];
  require(THEME_PATH);

  return { html, panel, windowStub, themeButtons, modeButtons };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.window;
}

test('applies the default green/light state to <html> on load', () => {
  const { html } = loadTheme();
  try {
    assert.equal(html.attrs['data-theme'], 'green');
    assert.equal(html.attrs['data-mode'], 'light');
  } finally { cleanup(); }
});

test('announces edit-mode availability to the host on load', () => {
  const { windowStub } = loadTheme();
  try {
    assert.deepEqual(windowStub.parent.posted[0], { type: '__edit_mode_available' });
  } finally { cleanup(); }
});

test('a theme button click applies and persists the new theme', () => {
  const { html, panel, windowStub, themeButtons } = loadTheme();
  try {
    const [greenBtn, claretBtn] = themeButtons;
    panel.listeners.click({ target: claretBtn });
    assert.equal(html.attrs['data-theme'], 'claret');
    assert.deepEqual(windowStub.parent.posted[windowStub.parent.posted.length - 1], { type: '__edit_mode_set_keys', edits: { theme: 'claret' } });
    assert.equal(claretBtn.classList.contains('active'), true);
    assert.equal(greenBtn.classList.contains('active'), false);
  } finally { cleanup(); }
});

test('a mode button click applies and persists dark mode without touching the theme', () => {
  const { html, panel, modeButtons } = loadTheme();
  try {
    const darkBtn = modeButtons[1];
    panel.listeners.click({ target: darkBtn });
    assert.equal(html.attrs['data-mode'], 'dark');
    assert.equal(html.attrs['data-theme'], 'green');
  } finally { cleanup(); }
});

test('__activate_edit_mode reveals the panel and __deactivate_edit_mode hides it', () => {
  const { panel, windowStub } = loadTheme();
  try {
    windowStub.listeners.message({ data: { type: '__activate_edit_mode' } });
    assert.equal(panel.hidden, false);
    windowStub.listeners.message({ data: { type: '__deactivate_edit_mode' } });
    assert.equal(panel.hidden, true);
    assert.doesNotThrow(() => windowStub.listeners.message({}));
  } finally { cleanup(); }
});

test('a page with no theme-switcher panel loads without throwing', () => {
  let html;
  assert.doesNotThrow(() => { ({ html } = loadTheme({ withPanel: false })); });
  try {
    assert.equal(html.attrs['data-theme'], 'green');
    assert.equal(html.attrs['data-mode'], 'light');
  } finally { cleanup(); }
});
