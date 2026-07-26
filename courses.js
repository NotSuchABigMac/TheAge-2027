(function (global, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    // Node.js / CommonJS
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(factory);
  } else {
    // Browser global
    global.COURSES = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const COURSES = {
    MURRAY: {
      name: 'Murray Course',
      tee: 'White',
      unit: 'm',
      holes: [
        { hole: 1, par: 4, si: 6, distance: 373 },
        { hole: 2, par: 3, si: 18, distance: 162 },
        { hole: 3, par: 4, si: 13, distance: 385 },
        { hole: 4, par: 4, si: 4, distance: 379 },
        { hole: 5, par: 5, si: 9, distance: 514 },
        { hole: 6, par: 4, si: 3, distance: 418 },
        { hole: 7, par: 4, si: 16, distance: 366 },
        { hole: 8, par: 3, si: 12, distance: 206 },
        { hole: 9, par: 5, si: 7, distance: 572 },
        { hole: 10, par: 3, si: 14, distance: 172 },
        { hole: 11, par: 5, si: 15, distance: 529 },
        { hole: 12, par: 4, si: 2, distance: 392 },
        { hole: 13, par: 3, si: 8, distance: 201 },
        { hole: 14, par: 5, si: 10, distance: 563 },
        { hole: 15, par: 4, si: 11, distance: 370 },
        { hole: 16, par: 5, si: 1, distance: 570 },
        { hole: 17, par: 3, si: 17, distance: 137 },
        { hole: 18, par: 4, si: 5, distance: 388 }
      ]
    },
    BLACK_BULL: {
      name: 'Black Bull Course',
      tee: 'White',
      unit: 'm',
      holes: [
        { hole: 1, par: 4, si: 16, distance: 337 },
        { hole: 2, par: 5, si: 6, distance: 530 },
        { hole: 3, par: 4, si: 9, distance: 363 },
        { hole: 4, par: 3, si: 11, distance: 179 },
        { hole: 5, par: 4, si: 12, distance: 364 },
        { hole: 6, par: 4, si: 1, distance: 405 },
        { hole: 7, par: 5, si: 14, distance: 483 },
        { hole: 8, par: 3, si: 4, distance: 197 },
        { hole: 9, par: 4, si: 13, distance: 359 },
        { hole: 10, par: 4, si: 5, distance: 391 },
        { hole: 11, par: 4, si: 3, distance: 414 },
        { hole: 12, par: 4, si: 7, distance: 365 },
        { hole: 13, par: 5, si: 10, distance: 510 },
        { hole: 14, par: 3, si: 18, distance: 135 },
        { hole: 15, par: 4, si: 2, distance: 392 },
        { hole: 16, par: 3, si: 17, distance: 144 },
        { hole: 17, par: 4, si: 8, distance: 365 },
        { hole: 18, par: 5, si: 15, distance: 494 }
      ]
    },
    LAKE: {
      name: 'Lake Course',
      tee: 'Blue',
      unit: 'm',
      holes: [
        { hole: 1, par: 4, si: 9, distance: 366 },
        { hole: 2, par: 3, si: 14, distance: 165 },
        { hole: 3, par: 4, si: 3, distance: 393 },
        { hole: 4, par: 4, si: 7, distance: 365 },
        { hole: 5, par: 5, si: 15, distance: 507 },
        { hole: 6, par: 4, si: 1, distance: 417 },
        { hole: 7, par: 3, si: 18, distance: 135 },
        { hole: 8, par: 4, si: 11, distance: 309 },
        { hole: 9, par: 5, si: 17, distance: 472 },
        { hole: 10, par: 4, si: 4, distance: 409 },
        { hole: 11, par: 4, si: 10, distance: 378 },
        { hole: 12, par: 3, si: 8, distance: 189 },
        { hole: 13, par: 5, si: 5, distance: 581 },
        { hole: 14, par: 3, si: 13, distance: 171 },
        { hole: 15, par: 4, si: 12, distance: 352 },
        { hole: 16, par: 4, si: 6, distance: 410 },
        { hole: 17, par: 4, si: 2, distance: 400 },
        { hole: 18, par: 5, si: 16, distance: 503 }
      ]
    }
  };

  // Compute totals for each course
  function computeTotals(holes) {
    const front9 = holes.slice(0, 9);
    const back9 = holes.slice(9, 18);

    return {
      front9Par: front9.reduce((sum, h) => sum + h.par, 0),
      front9SI: front9.reduce((sum, h) => sum + h.si, 0),
      front9Distance: front9.reduce((sum, h) => sum + h.distance, 0),
      back9Par: back9.reduce((sum, h) => sum + h.par, 0),
      back9SI: back9.reduce((sum, h) => sum + h.si, 0),
      back9Distance: back9.reduce((sum, h) => sum + h.distance, 0),
      totalPar: holes.reduce((sum, h) => sum + h.par, 0),
      totalSI: holes.reduce((sum, h) => sum + h.si, 0),
      totalDistance: holes.reduce((sum, h) => sum + h.distance, 0)
    };
  }

  // Attach totals to each course
  Object.keys(COURSES).forEach(courseKey => {
    COURSES[courseKey].totals = computeTotals(COURSES[courseKey].holes);
  });

  return COURSES;
});
