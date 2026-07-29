/* ─────────────────────────────────────
   WONGA CUP — COURSE DATA
   Official scorecards (Blue tees) transcribed from the physical club
   cards for issue #122. Static data only — no DOM, no Supabase. Same
   UMD pattern as scoring.js, loaded the same way.

   Day → course mapping (see index.html / ARCHITECTURE.md):
     Day 1 (Fri) → Murray      (key 1) — Singles Match Play
     Day 2 (Sat) → Black Bull  (key 2) — Team Scramble
     Day 3 (Sun) → Lake        (key 3) — Individual Net Stableford

   out/in/total below are the card's own printed OUT/IN/TOT figures,
   kept alongside the per-hole rows as an independent cross-check on
   the transcription (test/courses.test.mjs asserts the holes sum to
   these, not the other way around).
───────────────────────────────────── */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WongaCourses = mod;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const COURSES = {
    1: {
      name: 'Murray',
      tee: 'Blue',
      holes: [
        { hole: 1,  par: 4, si: 6,  dist: 373 },
        { hole: 2,  par: 3, si: 18, dist: 162 },
        { hole: 3,  par: 4, si: 13, dist: 385 },
        { hole: 4,  par: 4, si: 4,  dist: 379 },
        { hole: 5,  par: 5, si: 9,  dist: 514 },
        { hole: 6,  par: 4, si: 3,  dist: 418 },
        { hole: 7,  par: 4, si: 16, dist: 366 },
        { hole: 8,  par: 3, si: 12, dist: 206 },
        { hole: 9,  par: 5, si: 7,  dist: 572 },
        { hole: 10, par: 3, si: 14, dist: 172 },
        { hole: 11, par: 5, si: 15, dist: 529 },
        { hole: 12, par: 4, si: 2,  dist: 392 },
        { hole: 13, par: 3, si: 8,  dist: 201 },
        { hole: 14, par: 5, si: 10, dist: 563 },
        { hole: 15, par: 4, si: 11, dist: 370 },
        { hole: 16, par: 5, si: 1,  dist: 570 },
        { hole: 17, par: 3, si: 17, dist: 137 },
        { hole: 18, par: 4, si: 5,  dist: 388 }
      ],
      out: { par: 36, dist: 3375 },
      in: { par: 36, dist: 3322 },
      total: { par: 72, dist: 6697 }
    },
    2: {
      name: 'Black Bull',
      tee: 'Blue',
      holes: [
        { hole: 1,  par: 4, si: 16, dist: 337 },
        { hole: 2,  par: 5, si: 6,  dist: 530 },
        { hole: 3,  par: 4, si: 9,  dist: 363 },
        { hole: 4,  par: 3, si: 11, dist: 179 },
        { hole: 5,  par: 4, si: 12, dist: 364 },
        { hole: 6,  par: 4, si: 1,  dist: 405 },
        { hole: 7,  par: 5, si: 14, dist: 483 },
        { hole: 8,  par: 3, si: 4,  dist: 197 },
        { hole: 9,  par: 4, si: 13, dist: 359 },
        { hole: 10, par: 4, si: 5,  dist: 391 },
        { hole: 11, par: 4, si: 3,  dist: 414 },
        { hole: 12, par: 4, si: 7,  dist: 365 },
        { hole: 13, par: 5, si: 10, dist: 510 },
        { hole: 14, par: 3, si: 18, dist: 135 },
        { hole: 15, par: 4, si: 2,  dist: 392 },
        { hole: 16, par: 3, si: 17, dist: 144 },
        { hole: 17, par: 4, si: 8,  dist: 365 },
        { hole: 18, par: 5, si: 15, dist: 494 }
      ],
      out: { par: 36, dist: 3217 },
      in: { par: 36, dist: 3210 },
      total: { par: 72, dist: 6427 }
    },
    3: {
      name: 'Lake',
      tee: 'Blue',
      holes: [
        { hole: 1,  par: 4, si: 9,  dist: 366 },
        { hole: 2,  par: 3, si: 14, dist: 165 },
        { hole: 3,  par: 4, si: 3,  dist: 393 },
        { hole: 4,  par: 4, si: 7,  dist: 365 },
        { hole: 5,  par: 5, si: 15, dist: 507 },
        { hole: 6,  par: 4, si: 1,  dist: 417 },
        { hole: 7,  par: 3, si: 18, dist: 135 },
        { hole: 8,  par: 4, si: 11, dist: 309 },
        { hole: 9,  par: 5, si: 17, dist: 472 },
        { hole: 10, par: 4, si: 4,  dist: 409 },
        { hole: 11, par: 4, si: 10, dist: 378 },
        { hole: 12, par: 3, si: 8,  dist: 189 },
        { hole: 13, par: 5, si: 5,  dist: 581 },
        { hole: 14, par: 3, si: 13, dist: 171 },
        { hole: 15, par: 4, si: 12, dist: 352 },
        { hole: 16, par: 4, si: 6,  dist: 410 },
        { hole: 17, par: 4, si: 2,  dist: 400 },
        { hole: 18, par: 5, si: 16, dist: 503 }
      ],
      out: { par: 36, dist: 3129 },
      in: { par: 36, dist: 3393 },
      total: { par: 72, dist: 6522 }
    }
  };

  // Nearest-the-Pin holes per day, matching the hardcoded ntp-dayN-hM ids
  // already in scorecard-live.html (issue #122 background).
  const NTP_HOLES = { 1: [8, 17], 2: [4, 16], 3: [7, 14] };

  function courseForDay(day) {
    return COURSES[day] || null;
  }

  return { COURSES, NTP_HOLES, courseForDay };
});
