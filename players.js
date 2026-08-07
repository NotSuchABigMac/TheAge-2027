/* ─────────────────────────────────────
   WONGA CUP — PLAYER ROSTER
   Static data only — no DOM, no Supabase. Same UMD pattern as
   courses.js/scoring.js, loaded the same way.

   Extracted from scorecard-live.html (issue #203) so index.html's
   season-totals computation (WongaScoring.computeSeasonTotals) can read
   the same handicaps the live scorecard scores against, without a
   second, driftable copy of the roster.
───────────────────────────────────── */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WongaPlayers = mod;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const PLAYERS = [
    { id:0,  name:'Brendan Cunningham', short:'B. Cunningham', hcp:'10.0', seed:2,  friday:true  },
    { id:1,  name:'Gary King',          short:'G. King',       hcp:'8.0',  seed:1,  friday:true  },
    { id:2,  name:'Matthew Smith',      short:'M. Smith',      hcp:'16.0', seed:3,  friday:true  },
    { id:3,  name:'James McIntyre',     short:'J. McIntyre',   hcp:'19.0', seed:5,  friday:true  },
    { id:4,  name:'Cayden Woods',       short:'C. Woods',      hcp:'23.0', seed:7,  friday:false },
    { id:5,  name:'Scott Rumbelow',     short:'S. Rumbelow',   hcp:'23.0', seed:8,  friday:true  },
    { id:6,  name:'Matthew Freestun',   short:'M. Freestun',   hcp:'26.0', seed:9,  friday:true  },
    { id:7,  name:'Nathan Freestun',    short:'N. Freestun',   hcp:'26.0', seed:10, friday:true  },
    { id:8,  name:'Steve Koenig',       short:'S. Koenig',     hcp:'29.0', seed:11, friday:true  },
    { id:9,  name:'Jimmy Hepburn',      short:'J. Hepburn',    hcp:'30.0', seed:12, friday:true  },
    { id:10, name:'Robert Hughes',      short:'R. Hughes',     hcp:'39.0', seed:13, friday:true  },
    { id:11, name:'Ben Lepore',         short:'B. Lepore',     hcp:'44.0', seed:14, friday:false },
    { id:12, name:'Mark Swain',        short:'M. Swain',      hcp:'20.0', seed:6,  friday:true  },
    { id:13, name:'Liam Cannel',       short:'L. Cannel',     hcp:'18.0', seed:4,  friday:true  }
  ];

  return { PLAYERS };
});
