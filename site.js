// site.js — shared page chrome (music modal + mute toggle, masthead scroll,
// mobile menu) for the marketing pages (index/golfers/practical/records/
// format/print-cards/404). scorecard-live.html has no mobile menu and its
// own bespoke modal accessibility handling (it also covers the username
// modal), so it isn't a consumer of this file.
//
// Issue #182: this was inline-duplicated in all five pages and had
// already diverged three ways -- the #144 masthead fix only existed on
// index.html, format.html had its own separate hamburger implementation,
// and (before #183) only scorecard-live.html guarded the audio play()
// promise. Extracted here, loaded with the same ?v=__CACHEBUST__
// convention as theme.js, so any future fix (like #181's accessibility
// pass) is written once instead of five times.
//
// Self-executing, like theme.js -- every piece below guards on its own
// required elements existing, so it degrades safely on a page missing
// one (no hero, no hamburger, etc) rather than assuming all of them.
(function () {

  /* ─────────────────────────────────────
     MUSIC MODAL
     Issue #183: browser autoplay policy generally doesn't carry a user
     gesture across a page navigation, so play() on a consented-return
     visit is routinely rejected -- caught here (mirroring
     scorecard-live.html) and falls back to asking again rather than
     leaving an unhandled rejection and silently-dead music. Also persists
     playback position across navigations so each page doesn't restart
     the track from 0:00.
  ───────────────────────────────────── */
  // Exposed on window (like startMusic/dismissMusic below) so it's a
  // directly testable unit, not just reachable through startMusic()'s
  // full flow.
  window.seekToSavedMusicTime = function seekToSavedMusicTime(audio) {
    const saved = parseFloat(sessionStorage.getItem('musicTime') || '0');
    if (!(saved > 0)) return;
    if (audio.readyState >= 1) audio.currentTime = saved;
    else audio.addEventListener('loadedmetadata', () => { audio.currentTime = saved; }, { once: true });
  };
  const seekToSavedMusicTime = window.seekToSavedMusicTime;
  window.addEventListener('pagehide', () => {
    const audio = document.getElementById('bg-audio');
    if (audio && !audio.paused) sessionStorage.setItem('musicTime', String(audio.currentTime));
  });
  // Grant consent and start playing. Called both by the consent modal's
  // own button and by the mute toggle's unmute branch -- clicking "unmute"
  // before consent has ever been given is the same explicit gesture the
  // modal would otherwise have collected, so it grants consent too.
  // The modal is looked up defensively because the toggle exists on pages
  // that carry no consent modal at all.
  window.startMusic = function startMusic() {
    document.getElementById('music-modal')?.classList.add('hidden');
    sessionStorage.setItem('musicConsented', '1');
    sessionStorage.removeItem('musicMuted');
    const audio = document.getElementById('bg-audio');
    seekToSavedMusicTime(audio);
    audio.play().catch(() => {});
  };
  window.dismissMusic = function dismissMusic() {
    document.getElementById('music-modal').classList.add('hidden');
    sessionStorage.setItem('musicConsented', 'dismissed');
  };
  const musicModal = document.getElementById('music-modal');
  if (musicModal) {
    // Issue #297: the consent popup used to fire on whichever page
    // happened to load first in a session, which is jarring on a
    // deep-linked/shared link straight to an inner page. Now it only
    // ever shows itself on the homepage -- every other page silently
    // respects the existing musicConsented session state (autoplay if
    // '1' and not explicitly muted, stay silent otherwise) without
    // re-prompting, even if that autoplay attempt gets rejected.
    // index.html was the homepage through 2026; the 2027 pivot moved that
    // tournament homepage to index2026.html (index.html is now the AGE
    // 2027 placeholder and carries no #music-modal at all, so it never
    // reaches this branch). Both are matched so a page rename here isn't
    // a repeat of this bug.
    const path = location.pathname.split('/').pop();
    const isHomepage = path === '' || path === 'index.html' || path === 'index2026.html';
    const consented = sessionStorage.getItem('musicConsented');
    if (!consented) {
      if (isHomepage) musicModal.classList.remove('hidden');
    } else if (consented === '1' && sessionStorage.getItem('musicMuted') !== '1') {
      const audio = document.getElementById('bg-audio');
      seekToSavedMusicTime(audio);
      audio.play().catch(() => { if (isHomepage) musicModal.classList.remove('hidden'); });
    }
    // Hitting Back/Forward often restores this page from the browser's
    // bfcache instead of a fresh navigation -- no script re-executes, so
    // none of the logic above runs. Chrome auto-pauses any playing
    // <audio>/<video> when a page freezes for bfcache and does NOT resume
    // it on restore, so without this the music just silently stops.
    // currentTime survives the freeze, so just resuming is enough.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      if (sessionStorage.getItem('musicConsented') !== '1') return;
      if (sessionStorage.getItem('musicMuted') === '1') return;
      const audio = document.getElementById('bg-audio');
      if (audio && audio.paused) audio.play().catch(() => { if (isHomepage) musicModal.classList.remove('hidden'); });
    });
  }

  /* ─────────────────────────────────────
     MUTE BUTTON (issue #297)
     Persistent, independent of the initial consent modal -- once shown,
     toggles bg-audio playback at any time. Injected here rather than
     duplicated as per-page markup, so every page that loads site.js
     gets it for free. Clicking "unmute" before consent has ever been
     given counts as the explicit gesture the consent modal would
     otherwise have collected, so it also grants consent (mirrors
     startMusic()); clicking "mute" persists musicMuted so a later
     navigation/bfcache-restore doesn't silently resume playback.

     Two mirrored buttons, not one: the fixed-width masthead bar has no
     spare room next to the (nowrap, non-truncating) page title on a
     narrow phone -- a second icon there visibly collided with the
     title text below ~360px. `.music-toggle` is CSS-hidden in the
     masthead under that breakpoint (see styles.css); this injects a
     second, labeled copy into the roomier mobile-menu dropdown so the
     control is never actually lost, just relocated. Both stay in sync
     off the same `render()`.
  ───────────────────────────────────── */
  (function initMusicToggle() {
    const audio = document.getElementById('bg-audio');
    const mastheadRight = document.querySelector('.masthead-right');
    if (!audio || !mastheadRight) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'music-toggle';
    mastheadRight.insertBefore(btn, document.getElementById('hamburger') || null);

    const mobileMenu = document.getElementById('mobile-menu');
    let mobileBtn = null;
    if (mobileMenu) {
      mobileBtn = document.createElement('button');
      mobileBtn.type = 'button';
      mobileBtn.className = 'mm-link mm-music-toggle';
      mobileMenu.insertBefore(mobileBtn, mobileMenu.querySelector('.mm-cta'));
    }

    function render() {
      const muted = audio.paused;
      const icon = muted ? '🔇' : '🔊';
      const label = muted ? 'Unmute music' : 'Mute music';
      btn.textContent = icon;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', String(!muted));
      if (mobileBtn) {
        mobileBtn.textContent = `${icon} ${label}`;
        mobileBtn.setAttribute('aria-pressed', String(!muted));
      }
    }
    function toggle() {
      if (audio.paused) {
        // Unmuting *is* startMusic() -- this branch was a line-for-line
        // copy of it, which is how the two could have drifted.
        window.startMusic();
      } else {
        sessionStorage.setItem('musicTime', String(audio.currentTime));
        audio.pause();
        sessionStorage.setItem('musicMuted', '1');
      }
    }
    btn.addEventListener('click', toggle);
    if (mobileBtn) mobileBtn.addEventListener('click', toggle);
    audio.addEventListener('play', render);
    audio.addEventListener('pause', render);
    render();
  })();

  /* ─────────────────────────────────────
     MASTHEAD SCROLL
     Transparent while floating over a hero photo, solid once scrolled
     past it. Only meaningful on a page that actually has a `.hero` --
     without one, the masthead is permanently solid in the markup itself
     and this must leave it alone entirely (an earlier draft of this
     extraction ran the scrollY-fallback branch unconditionally, which
     would have incorrectly toggled a hero-less page's masthead off at
     the top of the page).

     Previously driven by a raw `window.scrollY > 80` check -- on mobile,
     the browser's collapsing/expanding address bar can shift scrollY by
     more than 80px on load/render with no real user scroll, tripping
     masthead--scrolled immediately and leaving the header stuck solid
     even with the hero fully in view (issue #144). Driving this off the
     hero section's own visibility via IntersectionObserver sidesteps that
     entirely -- it only reacts to the hero actually leaving the area
     under the fixed header, not to any particular scrollY number.
  ───────────────────────────────────── */
  (function initMastheadScroll() {
    const mast = document.querySelector('.masthead');
    const hero = document.querySelector('.hero');
    if (!mast || !hero) return;
    function updateFromRect() {
      // Chrome for Android has a long-standing class of bug where fixed-
      // position elements (and the viewport metrics used to lay them out)
      // can be wrong at initial paint and only self-correct once the user
      // touches the screen and forces a reflow (see
      // https://issuetracker.google.com/issues/36943422). That can make
      // the very first IntersectionObserver callback below run against
      // stale geometry, latching masthead--scrolled on with the hero
      // fully in view and nothing afterward to un-stick it. Recomputing
      // directly from getBoundingClientRect on a short delay and on first
      // touch is a cheap, independent safety net against that.
      mast.classList.toggle('masthead--scrolled', hero.getBoundingClientRect().bottom <= 80);
    }
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback for browsers without IntersectionObserver: the original
      // scrollY check, now also re-run on resize so an address-bar
      // collapse/expand can't leave it stuck in a stale state.
      function update() { mast.classList.toggle('masthead--scrolled', window.scrollY > 80); }
      window.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update, { passive: true });
      update();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => { mast.classList.toggle('masthead--scrolled', !entries[0].isIntersecting); },
      { rootMargin: '-80px 0px 0px 0px', threshold: 0 }
    );
    observer.observe(hero);
    window.addEventListener('touchstart', updateFromRect, { once: true, passive: true });
    setTimeout(updateFromRect, 400);
  })();

  /* ─────────────────────────────────────
     MOBILE MENU
     Issue #181 item 1: a closed-but-still-focusable mobile menu is an
     outright WAI-ARIA violation (focusable content inside aria-hidden) --
     `inert` actually removes it from the tab order/accessibility tree,
     aria-hidden alone never did.
  ───────────────────────────────────── */
  window.toggleMenu = function toggleMenu() {
    const menu = document.getElementById('mobile-menu');
    const btn = document.getElementById('hamburger');
    const open = menu.classList.toggle('is-open');
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open);
    menu.setAttribute('aria-hidden', !open);
    menu.toggleAttribute('inert', !open);
    document.body.style.overflow = open ? 'hidden' : '';
  };
  window.closeMenu = function closeMenu() {
    const menu = document.getElementById('mobile-menu');
    const btn = document.getElementById('hamburger');
    menu.classList.remove('is-open');
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
    menu.setAttribute('inert', '');
    document.body.style.overflow = '';
  };
  const hamburger = document.getElementById('hamburger');
  if (hamburger) hamburger.addEventListener('click', window.toggleMenu);

  /* ─────────────────────────────────────
     OVERLAY ACCESSIBILITY — Escape-to-close + focus trap + focus restore
     (issue #181 item 2). `isOpenFn` decouples this from which
     class/attribute a given overlay happens to use to represent "open".
  ───────────────────────────────────── */
  function getFocusable(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }
  function setupOverlayA11y(el, isOpenFn, onEscape) {
    if (!el) return;
    let lastFocused = null;
    let wasOpen = false;
    new MutationObserver(() => {
      const isOpen = isOpenFn();
      if (isOpen && !wasOpen) {
        lastFocused = document.activeElement;
        const first = getFocusable(el)[0];
        if (first) first.focus();
      } else if (!isOpen && wasOpen && lastFocused) {
        lastFocused.focus();
        lastFocused = null;
      }
      wasOpen = isOpen;
    }).observe(el, { attributes: true, attributeFilter: ['class', 'aria-hidden'] });
    el.addEventListener('keydown', e => {
      if (!isOpenFn()) return;
      if (e.key === 'Escape') { onEscape(); return; }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(el);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
  }
  setupOverlayA11y(musicModal, () => musicModal && !musicModal.classList.contains('hidden'), window.dismissMusic);
  const mobileMenuEl = document.getElementById('mobile-menu');
  setupOverlayA11y(mobileMenuEl, () => mobileMenuEl.classList.contains('is-open'), window.closeMenu);

})();
