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

function metaStub() {
  return { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
}

// Mirrors the real --canvas values from styles.css's [data-theme][data-mode]
// rules closely enough to exercise the read-back-from-CSS behavior; theme.js
// never hardcodes this table itself, styles.css remains the one source of truth.
const CANVAS_BY_THEME_MODE = {
  'green:light': '#efe7d3',
  'green:dark': '#0c1d14',
  'claret:light': '#f3e8d2',
  'claret:dark': '#1c0a0d'
};

function getComputedStyleStub(html) {
  return {
    getPropertyValue(prop) {
      if (prop !== '--canvas') return '';
      const key = `${html.attrs['data-theme'] || 'green'}:${html.attrs['data-mode'] || 'light'}`;
      return CANVAS_BY_THEME_MODE[key] || '';
    }
  };
}

function localStorageStub(seed) {
  const store = new Map(seed ? [[seed.key, seed.value]] : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
}

function loadTheme({ withPanel = true, storedTheme = null } = {}) {
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

  const colorSchemeMeta = metaStub();
  const themeColorMeta = metaStub();

  const documentStub = {
    documentElement: html,
    getElementById: (id) => (withPanel && id === 'theme-switcher' ? panel : null),
    querySelector: (sel) => {
      if (sel === 'meta[name="color-scheme"]') return colorSchemeMeta;
      if (sel === 'meta[name="theme-color"]') return themeColorMeta;
      return null;
    }
  };

  const windowStub = {
    listeners: {},
    addEventListener(t, fn) { this.listeners[t] = fn; },
    parent: { posted: [], postMessage(msg) { this.posted.push(msg); } }
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.localStorage = localStorageStub(
    storedTheme ? { key: 'wongaCup2026_theme', value: JSON.stringify(storedTheme) } : null
  );
  globalThis.getComputedStyle = () => getComputedStyleStub(html);
  delete require.cache[THEME_PATH];
  require(THEME_PATH);

  return { html, panel, windowStub, themeButtons, modeButtons, colorSchemeMeta, themeColorMeta };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.getComputedStyle;
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

test('issue #184: a theme choice is written to localStorage so it survives a real navigation/refresh, not just the edit-mode host', () => {
  const { panel, themeButtons, modeButtons } = loadTheme();
  try {
    panel.listeners.click({ target: themeButtons[1] }); // claret
    panel.listeners.click({ target: modeButtons[1] });  // dark
    const stored = JSON.parse(globalThis.localStorage.getItem('wongaCup2026_theme'));
    assert.deepEqual(stored, { theme: 'claret', mode: 'dark' });
  } finally { cleanup(); }
});

test('issue #184: a stored theme choice is restored on load, taking precedence over the page default, and meta tags sync to match', () => {
  const { html, colorSchemeMeta, themeColorMeta } = loadTheme({ storedTheme: { theme: 'claret', mode: 'dark' } });
  try {
    assert.equal(html.attrs['data-theme'], 'claret');
    assert.equal(html.attrs['data-mode'], 'dark');
    assert.equal(colorSchemeMeta.attrs.content, 'dark');
    assert.equal(themeColorMeta.attrs.content, '#1c0a0d');
  } finally { cleanup(); }
});

test('issue #184: an untouched default load leaves each page\'s own hand-picked meta values alone', () => {
  const { colorSchemeMeta, themeColorMeta } = loadTheme();
  try {
    assert.equal(colorSchemeMeta.attrs.content, undefined);
    assert.equal(themeColorMeta.attrs.content, undefined);
  } finally { cleanup(); }
});

test('issue #184: color-scheme and theme-color meta tags follow the active mode/theme once the visitor changes it', () => {
  const { panel, themeButtons, modeButtons, colorSchemeMeta, themeColorMeta } = loadTheme();
  try {
    panel.listeners.click({ target: themeButtons[1] }); // claret
    panel.listeners.click({ target: modeButtons[1] });  // dark
    assert.equal(colorSchemeMeta.attrs.content, 'dark');
    assert.equal(themeColorMeta.attrs.content, '#1c0a0d');
  } finally { cleanup(); }
});

test('issue #184: a missing/corrupt localStorage entry falls back to the page default without throwing', () => {
  let html;
  globalThis.document = undefined; // ensure loadTheme sets its own stub below
  assert.doesNotThrow(() => {
    const html2 = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    globalThis.document = {
      documentElement: html2,
      getElementById: () => null,
      querySelector: () => null
    };
    globalThis.window = { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, parent: { postMessage() {} } };
    globalThis.localStorage = { getItem: () => 'not json{', setItem() {}, removeItem() {} };
    delete require.cache[THEME_PATH];
    require(THEME_PATH);
    html = html2;
  });
  try {
    assert.equal(html.attrs['data-theme'], 'green');
    assert.equal(html.attrs['data-mode'], 'light');
  } finally { cleanup(); }
});
