/*
 * Lattice Game Sim: the model.
 *
 * Players on an L x L lattice (wrapping edges) each hold a memory-one strategy: five
 * probabilities of playing the game's first action (C, or Heads): p0 in round one, then one per
 * outcome of the previous round. Every generation each pair of neighbours plays the set number
 * of rounds (expected outcome computed exactly, or moves sampled), then every player copies one
 * random neighbour's whole vector with the Fermi probability. An optional learner at the centre
 * never imitates and improves its vector by trial and keep.
 *
 * This file has no page code. The browser page (index.html) loads it with a script tag and the
 * Node runner (run.js) with require(), so results and visuals always come from the same code.
 *
 *   const sim = LatticeModel.createSim({ game: "pd", seed: 3 });  // or require("./model.js")
 *   sim.restart(); for (let g = 0; g < 100; g++) sim.step();
 *   sim.measure();  // the per-generation record that run files log
 *
 * Behaviour is pinned by simulator/test/golden.test.js. If a change alters any result on purpose,
 * bump MODEL_VERSION and regenerate the golden file, since older run files are then not comparable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LatticeModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 2: any number of learners at random sites (version 1 had one learner at the centre)
  // 3: "history": "carry" keeps each pair's game going across generations (version 2 = "reset")
  // 4: grim trigger is its own class (was grouped with TFT); in carry mode the reference lines use
  //    each pair's long-run (stationary) play instead of a fresh 100-round game
  // 5: in carry mode p0 is used only in the first round, so strategies are classified on the four
  //    response entries and learners no longer perturb p0
  // 6: logs "cc", the share of pair rounds that end in mutual cooperation (PD; measurement only)
  const MODEL_VERSION = "6";

  // Parameters of one run. Every run file records the full set, after validation.
  const DEFAULTS = Object.freeze({
    game: "pd",                 // "pd" (Prisoner's Dilemma) or "mp" (matching pennies)
    T: 5, R: 3, P: 1, S: 0,     // PD payoffs
    stake: 1,                   // matching pennies: win +stake, lose -stake
    L: 100,                     // lattice side
    radius: Math.SQRT2,         // neighbour radius (1, sqrt 2, 2, sqrt 5, sqrt 8, 3)
    K: 0.05,                    // Fermi temperature
    rounds: 3,                  // rounds per pairing per generation
    history: "reset",           // "reset": a new game every generation (p0 opens it); "carry": one game
                                // per pair that never restarts (p0 only in the very first round)
    selfInteraction: false,     // PD only
    mode: "expected",           // "expected" (exact) or "sampled"
    seed: 1,
    learner: Object.freeze({ count: 0, W: 3, sigma: 0.1, copyable: true }), // count: learners at random sites
  });

  function createSim(params) {
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const CLASS_RADIUS = 0.5;
    const SWAP = [0, 2, 1, 3];

    // ------------------------------------------------------------------ games
    // Everything game-specific lives here. Each player holds five probabilities of playing the
    // game's first action (C, or Heads): p0 in round one, then one entry per outcome of the
    // previous round. pairExpected/pairSampled track the four outcomes from player a's side,
    // indexed (own action, opponent's action) = 0: AA, 1: AB, 2: BA, 3: BB, where A is the first
    // action. A role's map says which vector entry (1-4) a player uses after each of those outcomes.
    //
    // Prisoner's Dilemma: entries are pCC, pCD, pDC, pDD, so the map is the identity.
    // Matching pennies: entries are stated by win or loss, pHW, pHL, pTW, pTL (played Heads and
    // won, Heads and lost, Tails and won, Tails and lost), so they mean the same in either role.
    // The matcher wins when the coins match, the mismatcher when they differ.
    const MAP_PD = [1, 2, 3, 4];
    const MAP_MATCH = [1, 2, 4, 3];    // HH: H won, HT: H lost, TH: T lost, TT: T won
    const MAP_MISMATCH = [2, 1, 3, 4]; // HH: H lost, HT: H won, TH: T won, TT: T lost
    const GAMES = {
      pd: {
        id: "pd",
        comp: ["p0", "pCC", "pCD", "pDC", "pDD"],
        compLong: ["p0 (first move)", "pCC", "pCD", "pDC", "pDD"],
        // Colour classes. TFT and grim trigger differ only in pDC (forgive a partner who
        // cooperated after being exploited, or never forgive), which matters in continuing games.
        named: [
          { name: "ALLC", color: "--c-allc" },
          { name: "ALLD", color: "--c-alld" },
          { name: "TFT", color: "--c-tft" },
          { name: "grim", color: "--c-grim" },
          { name: "WSLS", color: "--c-wsls" },
        ],
        refs: [
          { name: "ALLC", v: [1, 1, 1, 1, 1], cls: 0 },
          { name: "ALLD", v: [0, 0, 0, 0, 0], cls: 1 },
          { name: "TFT", v: [1, 1, 0, 1, 0], cls: 2 },
          { name: "grim trigger", v: [1, 1, 0, 0, 0], cls: 3 },
          { name: "WSLS", v: [1, 1, 0, 0, 1], cls: 4 },
        ],
        dims: [0, 1, 2, 3, 4],
        rateWord: "C moves",
        rateOption: "Cooperation this generation",
        series: ["coop", "pay", "wmCoop", "wmPay", "mmCoop", "mmPay", "lCoop", "lPay"],
      },
      mp: {
        id: "mp",
        comp: ["p0", "pHW", "pHL", "pTW", "pTL"],
        compLong: ["p0 (first move)", "pHW (Heads, won)", "pHL (Heads, lost)", "pTW (Tails, won)", "pTL (Tails, lost)"],
        named: [
          { name: "always Heads", color: "--c-allc" },
          { name: "always Tails", color: "--c-alld" },
          { name: "WSLS", color: "--c-tft" },
          { name: "alternator", color: "--c-wsls" },
          { name: "50/50 random", color: "--c-random" },
        ],
        // compared on the four conditional entries only (the opening move matters for one round)
        refs: [
          { name: "always Heads", v: [1, 1, 1, 1, 1], cls: 0 },
          { name: "always Tails", v: [0, 0, 0, 0, 0], cls: 1 },
          { name: "win-stay lose-shift", v: [0.5, 1, 0, 0, 1], cls: 2 },
          { name: "alternator", v: [0.5, 0, 0, 1, 1], cls: 3 },
          { name: "50/50 random", v: [0.5, 0.5, 0.5, 0.5, 0.5], cls: 4 },
        ],
        dims: [1, 2, 3, 4],
        rateWord: "win rate",
        rateOption: "Win rate this generation",
        series: ["spread", "expl", "lCoop", "lPay"],
      },
    };
    let G = GAMES.pd, COMP = G.comp, NAMED = G.named, REFS = G.refs, MIXED = NAMED.length;

    // ------------------------------------------------------------------ model
    const S = {
      game: "pd", stake: 1,
      L: 50, r: Math.SQRT2, T: 5, R: 3, Sp: 0, P: 1, K: 0.2, m: 10, self: false, mode: "expected", seed: 1,
      N: 0, k: 0, nb: null, half: null, halfK: 0, X: null, Y: null, pay: null, coop: null, cls: null, rng: null, gen: 0,
      hist: null, history: "reset",
      // carry: each pair's last outcome (from the lower-indexed side of the pair's loop). Expected
      // mode keeps its probability distribution (4 per game), sampled mode the outcome (255 = none).
      edge: null, selfEdge: null, edgeReady: false,
      edgeStart: null, selfEdgeStart: null, edgeReadyStart: false, // state at the start of this generation
    };

    function offsets(r) {
      const R = Math.floor(r + 1e-9), out = [];
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if ((dy || dx) && dy * dy + dx * dx <= r * r + 1e-9) out.push([dy, dx]);
      }
      return out;
    }

    function buildLattice() {
      const L = S.L, N = L * L, off = offsets(S.r), k = off.length;
      const half = off.filter(([dy, dx]) => dy > 0 || (dy === 0 && dx > 0));
      S.N = N; S.k = k; S.halfK = half.length;
      S.nb = new Int32Array(N * k);
      S.half = new Int32Array(N * half.length);
      for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
        const i = y * L + x;
        off.forEach(([dy, dx], j) => { S.nb[i * k + j] = ((y + dy + L) % L) * L + ((x + dx + L) % L); });
        half.forEach(([dy, dx], j) => { S.half[i * half.length + j] = ((y + dy + L) % L) * L + ((x + dx + L) % L); });
      }
      S.X = new Float64Array(N * 5); S.Y = new Float64Array(N * 5);
      S.pay = new Float64Array(N); S.coop = new Float64Array(N); S.cls = new Uint8Array(N);
    }

    function restart() {
      S.rng = mulberry32(S.seed * 2654435761 + 12345);
      buildLattice();
      for (let i = 0; i < S.N * 5; i++) S.X[i] = S.rng();
      S.gen = 0;
      S.edge = null; S.selfEdge = null; S.edgeReady = false; S.edgeStart = null;
      S.hist = { gen: [], mean: [[], [], [], [], []], lVec: [[], [], [], [], []],
        cls: Array.from({ length: MIXED + 1 }, () => []) };
      G.series.forEach((k) => { S.hist[k] = []; });
      learnerInit();
      learnerApply();
      play();
      learnerObserve();
      record(false);
    }

    // ------------------------------------------------------------------ learners (trial and keep)
    // `count` players at random sites (chosen from the seed) never imitate. Each sees only its own
    // payoff: it plays its kept vector for W generations (measure), then a randomly perturbed
    // vector for W generations (try), and keeps the change if the trial window earned more than
    // the window before it. Each learner has its own random stream, and the sites come from a
    // separate stream, so adding learners does not change the imitators' random draws.
    const LR = {
      count: 0, copyable: true, W: 5, sigma: 0.1,
      list: [],          // one state object per learner
      isLearner: null,   // Uint8Array(N): 1 at learner sites
      get on() { return this.count > 0; },
    };
    function gauss(rng) {
      let u = 0;
      while (u === 0) u = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    }
    // Place the learners (a random sample of sites) and start each from the vector at its site.
    function learnerInit() {
      const N = S.N, n = Math.min(LR.count, N);
      LR.isLearner = new Uint8Array(N);
      LR.list = [];
      if (!n) return;
      const pick = mulberry32((Math.imul(S.seed + 7, 2246822519) ^ 0x2545f491) >>> 0);
      const idx = new Int32Array(N);
      for (let i = 0; i < N; i++) idx[i] = i;
      for (let k = 0; k < n; k++) { // partial Fisher-Yates shuffle
        const j = k + Math.floor(pick() * (N - k)), t = idx[k];
        idx[k] = idx[j]; idx[j] = t;
      }
      for (let k = 0; k < n; k++) {
        const site = idx[k];
        LR.isLearner[site] = 1;
        LR.list.push({
          site, kept: new Float64Array(S.X.subarray(site * 5, site * 5 + 5)), trial: new Float64Array(5),
          rng: mulberry32((Math.imul(S.seed + 3, 48271) + 99991 + Math.imul(k, 0x9e3779b1)) >>> 0),
          phase: "measure", t: 0, sum: 0, keptScore: NaN, keptFresh: false, trialScore: NaN, trials: 0, accepted: 0,
        });
      }
    }
    function learnerApply() {
      for (const l of LR.list) S.X.set(l.phase === "trial" ? l.trial : l.kept, l.site * 5);
    }
    function learnerObserve() {
      const kk = partners();
      for (const l of LR.list) {
        l.sum += S.pay[l.site] / kk;
        l.t += 1;
        if (l.t < LR.W) continue;
        const avg = l.sum / l.t;
        if (l.phase === "measure") {
          l.keptScore = avg; l.keptFresh = true;
        } else {
          l.trials += 1; l.trialScore = avg;
          if (avg > l.keptScore) { l.kept.set(l.trial); l.keptScore = avg; l.accepted += 1; }
          else l.keptFresh = false;
        }
        l.t = 0; l.sum = 0;
        if (l.keptFresh) {
          // in a continuing game p0 is never played again, so trials leave it as it is
          const q0 = S.history === "carry" ? 1 : 0;
          if (q0) l.trial[0] = l.kept[0];
          for (let q = q0; q < 5; q++) l.trial[q] = Math.min(1, Math.max(0, l.kept[q] + LR.sigma * gauss(l.rng)));
          l.phase = "trial";
        } else l.phase = "measure";
      }
    }

    // Outcome frequencies (AA, AB, BA, BB from player a's side) averaged over m rounds.
    // ma / mb: which vector entry a and b use after each outcome, seen from their own side.
    // With `st` (carry): the game continues from the outcome stored at st[so..] (once S.edgeReady),
    // and the last round's outcome is stored back there for the next generation.
    const F = new Float64Array(4);
    function pairExpected(X, a, b, m, ma = MAP_PD, mb = MAP_PD, st = null, so = 0) {
      const x0 = X[a], y0 = X[b];
      let v0, v1, v2, v3;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      const xa0 = X[a + ma[0]], xa1 = X[a + ma[1]], xa2 = X[a + ma[2]], xa3 = X[a + ma[3]];
      // b's P(first action) in a's outcome labels: b sees outcome s as SWAP[s]
      const yb0 = X[b + mb[0]], yb1 = X[b + mb[2]], yb2 = X[b + mb[1]], yb3 = X[b + mb[3]];
      if (st && S.edgeReady) { // the next round, from the stored last outcome and the current vectors
        const d0 = st[so], d1 = st[so + 1], d2 = st[so + 2], d3 = st[so + 3];
        const w0 = d0 * xa0, w1 = d1 * xa1, w2 = d2 * xa2, w3 = d3 * xa3;
        const u0 = d0 - w0, u1 = d1 - w1, u2 = d2 - w2, u3 = d3 - w3;
        v0 = w0 * yb0 + w1 * yb1 + w2 * yb2 + w3 * yb3;
        v2 = u0 * yb0 + u1 * yb1 + u2 * yb2 + u3 * yb3;
        v1 = w0 + w1 + w2 + w3 - v0; v3 = u0 + u1 + u2 + u3 - v2;
      } else {
        v0 = x0 * y0; v1 = x0 * (1 - y0); v2 = (1 - x0) * y0; v3 = (1 - x0) * (1 - y0);
      }
      for (let t = 0; t < m; t++) {
        s0 += v0; s1 += v1; s2 += v2; s3 += v3;
        if (st && t === m - 1) { st[so] = v0; st[so + 1] = v1; st[so + 2] = v2; st[so + 3] = v3; break; }
        const w0 = v0 * xa0, w1 = v1 * xa1, w2 = v2 * xa2, w3 = v3 * xa3;
        const u0 = v0 - w0, u1 = v1 - w1, u2 = v2 - w2, u3 = v3 - w3;
        const n0 = w0 * yb0 + w1 * yb1 + w2 * yb2 + w3 * yb3;
        const n2 = u0 * yb0 + u1 * yb1 + u2 * yb2 + u3 * yb3;
        v0 = n0; v1 = w0 + w1 + w2 + w3 - n0; v2 = n2; v3 = u0 + u1 + u2 + u3 - n2;
      }
      F[0] = s0 / m; F[1] = s1 / m; F[2] = s2 / m; F[3] = s3 / m;
    }
    function pairSampled(X, a, b, m, rng, ma = MAP_PD, mb = MAP_PD, st = null, so = 0) {
      F[0] = F[1] = F[2] = F[3] = 0;
      if (st) { // carry: no draws after the last round; the next generation draws from the stored outcome
        const last = S.edgeReady ? st[so] : 255;
        let xc, yc;
        if (last === 255) { xc = rng() < X[a]; yc = rng() < X[b]; }
        else { xc = rng() < X[a + ma[last]]; yc = rng() < X[b + mb[SWAP[last]]]; }
        let s = 0;
        for (let t = 0; t < m; t++) {
          if (t) { const nx = rng() < X[a + ma[s]], ny = rng() < X[b + mb[SWAP[s]]]; xc = nx; yc = ny; }
          s = (xc ? 0 : 2) + (yc ? 0 : 1);
          F[s] += 1;
        }
        st[so] = s;
        F[0] /= m; F[1] /= m; F[2] /= m; F[3] /= m;
        return;
      }
      let xc = rng() < X[a], yc = rng() < X[b];
      for (let t = 0; t < m; t++) {
        const s = (xc ? 0 : 2) + (yc ? 0 : 1);
        F[s] += 1;
        const nx = rng() < X[a + ma[s]], ny = rng() < X[b + mb[SWAP[s]]];
        xc = nx; yc = ny;
      }
      F[0] /= m; F[1] /= m; F[2] /= m; F[3] /= m;
    }
    // Long-run play of a pair in a game that never ends: the stationary distribution of the
    // four-outcome chain (from a's side), solved exactly. It does not depend on p0 or on how the
    // game started. If the chain has more than one long-run pattern (entries of exactly 0 or 1),
    // the average over PAIR_LONG rounds from the opening is used instead.
    const PAIR_LONG = 2000, PM = new Float64Array(16);
    function pairStationary(X, a, b, ma = MAP_PD, mb = MAP_PD) {
      const xa = [X[a + ma[0]], X[a + ma[1]], X[a + ma[2]], X[a + ma[3]]];
      const yb = [X[b + mb[0]], X[b + mb[2]], X[b + mb[1]], X[b + mb[3]]];
      // equations: sum_s pi_s (P[s][t] - [s == t]) = 0 for t = 0..2, and sum_s pi_s = 1
      for (let s = 0; s < 4; s++) {
        const x = xa[s], y = yb[s], row = [x * y, x * (1 - y), (1 - x) * y, (1 - x) * (1 - y)];
        for (let t = 0; t < 3; t++) PM[t * 4 + s] = row[t] - (s === t ? 1 : 0);
        PM[12 + s] = 1;
      }
      const rhs = [0, 0, 0, 1];
      for (let c = 0; c < 4; c++) { // Gaussian elimination with partial pivoting
        let piv = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(PM[r * 4 + c]) > Math.abs(PM[piv * 4 + c])) piv = r;
        if (Math.abs(PM[piv * 4 + c]) < 1e-12) { pairExpected(X, a, b, PAIR_LONG, ma, mb); return; }
        if (piv !== c) {
          for (let k = 0; k < 4; k++) { const t = PM[c * 4 + k]; PM[c * 4 + k] = PM[piv * 4 + k]; PM[piv * 4 + k] = t; }
          const t = rhs[c]; rhs[c] = rhs[piv]; rhs[piv] = t;
        }
        for (let r = 0; r < 4; r++) {
          if (r === c) continue;
          const f = PM[r * 4 + c] / PM[c * 4 + c];
          if (!f) continue;
          for (let k = c; k < 4; k++) PM[r * 4 + k] -= f * PM[c * 4 + k];
          rhs[r] -= f * rhs[c];
        }
      }
      for (let k = 0; k < 4; k++) F[k] = rhs[k] / PM[k * 4 + k];
    }

    // Carried state for every pair (games per pair: 1 in the PD, 2 in matching pennies) and for
    // self-play. Allocated on first use in carry mode; a fresh allocation starts from p0.
    // again = true replays the current generation (after a settings change) from the state it
    // started with, instead of advancing every game by another generation's rounds.
    function edgeState(again) {
      if (S.history !== "carry") return false;
      const gp = G.id === "mp" ? 2 : 1, sampled = S.mode === "sampled", w = sampled ? 1 : 4;
      const n = S.N * S.halfK * gp * w;
      const Type = sampled ? Uint8Array : Float64Array;
      if (!S.edge || S.edge.length !== n || !(S.edge instanceof Type)) {
        S.edge = new Type(n); S.selfEdge = new Type(S.N * w); S.edgeReady = false;
        S.edgeStart = null;
      }
      if (again && S.edgeStart && S.edgeStart.length === S.edge.length) {
        S.edge.set(S.edgeStart); S.selfEdge.set(S.selfEdgeStart); S.edgeReady = S.edgeReadyStart;
      } else {
        if (!S.edgeStart || S.edgeStart.length !== S.edge.length) { S.edgeStart = new Type(n); S.selfEdgeStart = new Type(S.N * w); }
        S.edgeStart.set(S.edge); S.selfEdgeStart.set(S.selfEdge); S.edgeReadyStart = S.edgeReady;
      }
      return true;
    }

    function play(again = false) {
      if (G.id === "mp") return playMP(again);
      const { N, X, pay, coop, half, halfK, m, R, T, P } = S, Sv = S.Sp;
      const sampled = S.mode === "sampled";
      const carry = edgeState(again), E = carry ? S.edge : null, SE = carry ? S.selfEdge : null, w = sampled ? 1 : 4;
      pay.fill(0); coop.fill(0);
      let cc = 0, pairs = 0;
      for (let i = 0; i < N; i++) {
        const a = i * 5;
        for (let h = 0; h < halfK; h++) {
          const j = half[i * halfK + h], b = j * 5, e = (i * halfK + h) * w;
          if (sampled) pairSampled(X, a, b, m, S.rng, MAP_PD, MAP_PD, E, e); else pairExpected(X, a, b, m, MAP_PD, MAP_PD, E, e);
          pay[i] += F[0] * R + F[1] * Sv + F[2] * T + F[3] * P;
          pay[j] += F[0] * R + F[1] * T + F[2] * Sv + F[3] * P;
          coop[i] += F[0] + F[1];
          coop[j] += F[0] + F[2];
          cc += F[0]; pairs += 1;
        }
        if (S.self) {
          if (sampled) pairSampled(X, a, a, m, S.rng, MAP_PD, MAP_PD, SE, i * w); else pairExpected(X, a, a, m, MAP_PD, MAP_PD, SE, i * w);
          pay[i] += F[0] * R + F[1] * Sv + F[2] * T + F[3] * P;
          coop[i] += F[0] + F[1];
        }
      }
      if (carry) S.edgeReady = true;
      S.ccShare = pairs ? cc / pairs : 0;
      classify();
    }

    // Matching pennies: every pair of neighbours plays twice, once with each player as the matcher.
    // A player's score from a pair is the average of the two games, so it lies in [-stake, +stake].
    // coop[] holds the win rate (share of rounds won, averaged over both roles).
    function playMP(again = false) {
      const { N, X, pay, coop, half, halfK, m } = S, st = S.stake;
      const sampled = S.mode === "sampled";
      const carry = edgeState(again), E = carry ? S.edge : null, w = sampled ? 1 : 4;
      pay.fill(0); coop.fill(0);
      for (let i = 0; i < N; i++) {
        const a = i * 5;
        for (let h = 0; h < halfK; h++) {
          const j = half[i * halfK + h], b = j * 5, e = (i * halfK + h) * 2 * w;
          // game 1: i matches, j mismatches; i wins on HH and TT
          if (sampled) pairSampled(X, a, b, m, S.rng, MAP_MATCH, MAP_MISMATCH, E, e); else pairExpected(X, a, b, m, MAP_MATCH, MAP_MISMATCH, E, e);
          const w1 = F[0] + F[3];
          // game 2: i mismatches, j matches; i wins on HT and TH
          if (sampled) pairSampled(X, a, b, m, S.rng, MAP_MISMATCH, MAP_MATCH, E, e + w); else pairExpected(X, a, b, m, MAP_MISMATCH, MAP_MATCH, E, e + w);
          const w2 = F[1] + F[2];
          const win = (w1 + w2) / 2;          // i's share of rounds won over both games
          const p = st * (2 * win - 1);        // i's average payoff per round; j gets -p
          pay[i] += p; pay[j] -= p;
          coop[i] += win; coop[j] += 1 - win;
        }
      }
      if (carry) S.edgeReady = true;
      classify();
    }

    function imitate() {
      const { N, X, Y, pay, nb, k, K, rng } = S;
      const isL = LR.isLearner, any = LR.list.length > 0, block = any && !LR.copyable;
      for (let i = 0; i < N; i++) {
        const j = nb[i * k + Math.floor(rng() * k)];
        const d = pay[j] - pay[i];
        const p = K > 0 ? 1 / (1 + Math.exp(-d / K)) : (d > 0 ? 1 : 0);
        let src = rng() < p ? j : i;
        if (any && (isL[i] || (block && isL[j]))) src = i; // learners never imitate
        const a = i * 5, b = src * 5;
        Y[a] = X[b]; Y[a + 1] = X[b + 1]; Y[a + 2] = X[b + 2]; Y[a + 3] = X[b + 3]; Y[a + 4] = X[b + 4];
      }
      S.X = Y; S.Y = X;
    }

    // The entries that matter for play: in a continuing game p0 opens only the very first round,
    // so strategies are compared on the four response entries (matching pennies always does).
    const DIMS4 = [1, 2, 3, 4];
    function playDims() { return S.history === "carry" ? DIMS4 : G.dims; }

    // Nearest reference strategy within CLASS_RADIUS (Euclidean over the game's dims); -1 if none.
    function nearest(X, i) {
      let best = -1, bd = CLASS_RADIUS * CLASS_RADIUS;
      const dims = playDims();
      for (let r = 0; r < REFS.length; r++) {
        const v = REFS[r].v;
        let d = 0;
        for (let k = 0; k < dims.length; k++) { const q = dims[k], e = X[i * 5 + q] - v[q]; d += e * e; }
        if (d < bd) { bd = d; best = r; }
      }
      return [best, Math.sqrt(bd)];
    }
    function classify() {
      const { N, X, cls } = S;
      for (let i = 0; i < N; i++) { const [r] = nearest(X, i); cls[i] = r < 0 ? MIXED : REFS[r].cls; }
    }

    function partners() { return S.k + (S.self ? 1 : 0); }

    function stats() {
      const { N, X, pay, coop, cls } = S, kk = partners();
      let c = 0, p = 0;
      const mean = [0, 0, 0, 0, 0], counts = new Array(MIXED + 1).fill(0);
      for (let i = 0; i < N; i++) {
        c += coop[i]; p += pay[i]; counts[cls[i]]++;
        for (let q = 0; q < 5; q++) mean[q] += X[i * 5 + q];
      }
      const out = { coop: c / (N * kk), pay: p / (N * kk), mean: mean.map((v) => v / N), cls: counts.map((v) => v / N) };
      if (G.id === "pd") out.cc = S.ccShare; // share of neighbour-pair rounds that are mutual cooperation
      if (G.id === "mp") {
        let ss = 0;
        for (let i = 0; i < N; i++) { const d = pay[i] / kk - out.pay; ss += d * d; }
        out.spread = Math.sqrt(ss / N);
        out.expl = exploitability(out.mean, refRounds(), S.stake);
      }
      return out;
    }

    // Matching pennies: what the best possible opponent earns per round against a player using
    // vector v, averaged over the two roles. Exact, by backward induction over the m rounds: the
    // opponent's choice in a round only matters through the payoff now and v's next move.
    function exploitability(v, m, stake) {
      let total = 0;
      for (const bestIsMatcher of [true, false]) {
        const vMap = bestIsMatcher ? MAP_MISMATCH : MAP_MATCH;  // v plays the other role
        const u = (a, o) => ((a === o) === bestIsMatcher ? stake : -stake); // a, o: 0 = Heads, 1 = Tails
        // probability v plays Heads after outcome s = (best's action, v's action), seen from v's side
        const q = (s) => v[vMap[SWAP[s]]];
        let V = [0, 0, 0, 0]; // value of the rounds still to come, given the last outcome
        for (let t = m; t >= 2; t--) {
          const next = [0, 0, 0, 0];
          for (let s = 0; s < 4; s++) {
            const h = q(s);
            next[s] = Math.max(...[0, 1].map((a) => h * (u(a, 0) + V[a * 2]) + (1 - h) * (u(a, 1) + V[a * 2 + 1])));
          }
          V = next;
        }
        const h = v[0];
        total += Math.max(...[0, 1].map((a) => h * (u(a, 0) + V[a * 2]) + (1 - h) * (u(a, 1) + V[a * 2 + 1])));
      }
      return total / 2 / m;
    }

    // Reference lines. Mean vs mean: the population's mean vector against itself (exact).
    // Well-mixed: expected outcome of WM_PAIRS random pairs of players drawn from anywhere on
    // the lattice. It uses its own random stream, so it never changes the run itself.
    // In carry mode the games never end, so the references use each pair's long-run (stationary)
    // play. Exploitability (matching pennies) uses a REF_ROUNDS-round game there.
    const WM_PAIRS = 5000, RX = new Float64Array(10), REF_ROUNDS = 100;
    function refRounds() { return S.history === "carry" ? REF_ROUNDS : S.m; }
    function references(mean) {
      const { R, T, P, N, X, m } = S, Sv = S.Sp, carry = S.history === "carry";
      const pair = (Xs, a, b) => (carry ? pairStationary(Xs, a, b) : pairExpected(Xs, a, b, m));
      RX.set(mean, 0); RX.set(mean, 5);
      pair(RX, 0, 5);
      const mmPay = F[0] * R + F[1] * Sv + F[2] * T + F[3] * P, mmCoop = F[0] + F[1];
      const rng = mulberry32((Math.imul(S.seed + 1, 7919) ^ Math.imul(S.gen + 1, 104729)) >>> 0);
      let wp = 0, wc = 0;
      for (let t = 0; t < WM_PAIRS; t++) {
        const i = Math.floor(rng() * N);
        let j = Math.floor(rng() * (N - 1));
        if (j >= i) j += 1;
        pair(X, i * 5, j * 5);
        wp += F[0] * R + F[1] * Sv + F[2] * T + F[3] * P;
        wc += F[0] + F[1];
      }
      return { mmPay, mmCoop, wmPay: wp / WM_PAIRS, wmCoop: wc / WM_PAIRS };
    }

    function record(replaceLast) {
      const s = stats(), h = S.hist, kk = partners(), SERIES = G.series;
      if (G.id === "pd") Object.assign(s, references(s.mean));
      // learners: averages over all learners (NaN when there are none)
      const ls = LR.list, nl = ls.length;
      s.lPay = nl ? ls.reduce((a, l) => a + S.pay[l.site], 0) / (nl * kk) : NaN;
      s.lCoop = nl ? ls.reduce((a, l) => a + S.coop[l.site], 0) / (nl * kk) : NaN;
      s.lVec = [0, 1, 2, 3, 4].map((q) => (nl ? ls.reduce((a, l) => a + S.X[l.site * 5 + q], 0) / nl : NaN));
      s.lCls = new Array(MIXED + 1).fill(0);
      for (const l of ls) s.lCls[S.cls[l.site]] += 1 / nl;
      if (replaceLast && h.gen.length) {
        h.gen.pop(); SERIES.forEach((k) => h[k].pop());
        for (let q = 0; q < 5; q++) { h.mean[q].pop(); h.lVec[q].pop(); }
        h.cls.forEach((arr) => arr.pop());
      }
      h.gen.push(S.gen); SERIES.forEach((k) => h[k].push(s[k]));
      for (let q = 0; q < 5; q++) { h.mean[q].push(s.mean[q]); h.lVec[q].push(s.lVec[q]); }
      h.cls.forEach((arr, c) => arr.push(s.cls[c]));
      if (h.gen.length > 3000) { // keep memory bounded: drop every other old point
        const keep = (arr) => arr.filter((_, i) => i % 2 === 0 || i >= arr.length - 500);
        h.gen = keep(h.gen); SERIES.forEach((k) => { h[k] = keep(h[k]); });
        h.mean = h.mean.map(keep); h.cls = h.cls.map(keep); h.lVec = h.lVec.map(keep);
      }
      S.last = s;
    }

    function step() {
      const t0 = performance.now();
      imitate();
      S.gen += 1;
      learnerApply();   // the vector the learner plays this generation (kept or trial)
      play();
      learnerObserve(); // add this generation's payoff to its window; decide at the window's end
      record(false);
      S.lastMs = performance.now() - t0;
    }

    // ---------------------------------------------------------------- parameters
    function setGame(id) {
      if (!GAMES[id]) throw new Error(`unknown game "${id}"; use one of ${Object.keys(GAMES).join(", ")}`);
      G = GAMES[id]; COMP = G.comp; NAMED = G.named; REFS = G.refs; MIXED = NAMED.length;
      S.game = id;
    }
    function num(v, fallback) {
      const x = typeof v === "number" ? v : parseFloat(v);
      return Number.isFinite(x) ? x : fallback;
    }
    // Merge p into the current parameters and apply them (the same validation the page used).
    // Takes effect on the running lattice; call restart() to begin a new run with them.
    function configure(p) {
      const cur = S.params || DEFAULTS;
      const q = Object.assign({}, cur, p || {});
      const pl = Object.assign({}, (p && p.learner) || {});
      // older files say learner.on instead of a count: on means one learner
      if (pl.count === undefined && pl.on !== undefined) pl.count = pl.on ? 1 : 0;
      q.learner = Object.assign({}, cur.learner, pl);
      if (q.game !== G.id || !S.params) setGame(q.game);
      S.L = Math.max(3, Math.round(num(q.L, DEFAULTS.L))); S.r = num(q.radius, Math.SQRT2);
      S.T = num(q.T, 5); S.R = num(q.R, 3); S.Sp = num(q.S, 0); S.P = num(q.P, 1);
      S.K = Math.max(0, num(q.K, DEFAULTS.K)); S.m = Math.max(1, Math.round(num(q.rounds, DEFAULTS.rounds)));
      S.stake = Math.max(0.01, num(q.stake, 1));
      S.self = S.game === "pd" && !!q.selfInteraction; // playing yourself nets 0 in matching pennies
      S.mode = q.mode === "sampled" ? "sampled" : "expected";
      const history = q.history === "carry" ? "carry" : "reset";
      if (history !== S.history) S.edgeReady = false; // switching back to carry starts a fresh game
      S.history = history;
      S.seed = Math.max(0, Math.round(num(q.seed, 1)));
      LR.count = Math.max(0, Math.round(num(q.learner.count, 0))); LR.copyable = !!q.learner.copyable;
      LR.W = Math.max(1, Math.round(num(q.learner.W, DEFAULTS.learner.W))); LR.sigma = Math.max(0, num(q.learner.sigma, 0.1));
      S.params = {
        game: S.game, T: S.T, R: S.R, P: S.P, S: S.Sp, stake: S.stake, L: S.L, radius: S.r, K: S.K,
        rounds: S.m, history: S.history, selfInteraction: S.self, mode: S.mode, seed: S.seed,
        learner: { count: LR.count, W: LR.W, sigma: LR.sigma, copyable: LR.copyable },
      };
      return S.params;
    }

    // ---------------------------------------------------------------- measurements
    // Number of distinct strategy vectors (exact bit patterns, hashed to 53 bits).
    const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
    function distinctCount() {
      const seen = new Set(), X = S.X;
      for (let i = 0; i < S.N; i++) {
        let h1 = 0x811c9dc5, h2 = 0x9747b28c;
        for (let q = 0; q < 5; q++) {
          f64[0] = X[i * 5 + q];
          for (let w = 0; w < 2; w++) {
            h1 = Math.imul(h1 ^ u32[w], 16777619);
            h2 = Math.imul(h2 ^ u32[w], 0x5bd1e995); h2 ^= h2 >>> 15;
          }
        }
        seen.add((h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff));
      }
      return seen.size;
    }
    // The distinct vectors still present and how many players hold each, most common first.
    function survivors(limit = 500) {
      const counts = new Map(), X = S.X;
      for (let i = 0; i < S.N; i++) {
        const key = Array.from(X.subarray(i * 5, i * 5 + 5)).join(",");
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const list = [...counts.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ v: k.split(",").map(Number), n }));
      return { distinct: list.length, list: list.slice(0, limit), omitted: Math.max(0, list.length - limit) };
    }
    // The record a run file logs for the current generation.
    function measure() {
      const s = S.last;
      const r = { gen: S.gen, coop: s.coop, pay: s.pay, mean: s.mean.slice(), cls: s.cls.slice(), distinct: distinctCount() };
      if (G.id === "pd") Object.assign(r, { cc: s.cc, wmCoop: s.wmCoop, wmPay: s.wmPay, mmCoop: s.mmCoop, mmPay: s.mmPay });
      else Object.assign(r, { spread: s.spread, expl: s.expl });
      if (LR.list.length) Object.assign(r, {
        lPay: s.lPay, lCoop: s.lCoop, lVec: s.lVec.slice(), lCls: s.lCls.slice(),
        lAccepted: LR.list.reduce((a, l) => a + l.accepted, 0), lTrials: LR.list.reduce((a, l) => a + l.trials, 0),
      });
      return r;
    }

    const api = {
      S, LR, F, GAMES, MAP_MATCH, MAP_MISMATCH,
      get G() { return G; }, get COMP() { return COMP; }, get NAMED() { return NAMED; },
      get REFS() { return REFS; }, get MIXED() { return MIXED; },
      configure, restart, step, play, record, stats, measure, distinctCount, survivors,
      partners, nearest, playDims, classify, exploitability, pairExpected, pairSampled, pairStationary,
      learnerInit, learnerApply, learnerObserve,
    };
    configure(params);
    return api;
  }

  // ------------------------------------------------------------------ run files
  // One run file per parameter set and seed. Series are stored column by column.
  function buildRun({ params, generations, logEvery, records, survivors, classes, components, meta }) {
    const col = (k) => records.map((r) => (r[k] === undefined ? null : r[k]));
    const series = { gen: col("gen"), coop: col("coop"), pay: col("pay"), distinct: col("distinct") };
    for (const k of ["cc", "wmCoop", "wmPay", "mmCoop", "mmPay", "spread", "expl", "lPay", "lCoop", "lAccepted", "lTrials"]) {
      if (records.some((r) => r[k] !== undefined)) series[k] = col(k);
    }
    series.mean = Object.fromEntries(components.map((c, q) => [c, records.map((r) => r.mean[q])]));
    series.cls = Object.fromEntries(classes.map((c, i) => [c, records.map((r) => r.cls[i])]));
    if (records.some((r) => r.lVec)) series.lVec = Object.fromEntries(components.map((c, q) => [c, records.map((r) => (r.lVec ? r.lVec[q] : null))]));
    if (records.some((r) => r.lCls)) series.lCls = Object.fromEntries(classes.map((c, i) => [c, records.map((r) => (r.lCls ? r.lCls[i] : null))]));
    const fix = records.find((r) => r.distinct === 1);
    const last = records[records.length - 1];
    // series values keep 7 significant digits (enough for any plot); final values stay exact
    const r7 = (v) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toPrecision(7)) : v);
    const round = (x) => (Array.isArray(x) ? x.map(r7) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round(v)])));
    return Object.assign({
      schema: "lattice-game-sim/run@1",
      modelVersion: MODEL_VERSION,
      params, generations, logEvery, classes, components,
      final: Object.assign({}, last, { fixationGen: fix ? fix.gen : null, survivors }),
      series: round(series),
      replay: "index.html?" + replayQuery(params, generations),
    }, meta || {});
  }
  // Query string that opens a run in the page (works when the page is opened as a local file).
  function replayQuery(p, gen) {
    const q = new URLSearchParams();
    for (const k of ["game", "T", "R", "P", "S", "stake", "L", "radius", "K", "rounds", "history", "mode", "seed"]) q.set(k, String(p[k] ?? DEFAULTS[k]));
    q.set("self", p.selfInteraction ? "1" : "0");
    q.set("learners", String(p.learner.count));
    q.set("W", String(p.learner.W)); q.set("sigma", String(p.learner.sigma)); q.set("copyable", p.learner.copyable ? "1" : "0");
    if (gen !== undefined) q.set("gen", String(gen));
    return q.toString();
  }

  return { MODEL_VERSION, DEFAULTS, createSim, buildRun, replayQuery };
});
