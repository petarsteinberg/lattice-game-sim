/*
 * Lattice Game Sim: the experiment runner shared by the command line (run.js) and the experiment
 * designer page (designer.html, through designer-worker.js). It turns an experiment file into runs
 * and runs one of them; it does no file or network input or output, so both sides produce the same
 * run names and the same run files from the same model.js.
 *
 *   const R = require("./runner.js");            // or LatticeRunner in a page or worker
 *   const tasks = R.expand(experiment, model);   // model = require("./model.js") / LatticeModel
 *   const run = R.runTask(tasks[0], model, { model: info, runner: { node: process.version } });
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LatticeRunner = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- SHA-256
  // Plain synchronous SHA-256 (FIPS 180-4), so run names are computed the same way everywhere.
  // Takes a string (hashed as UTF-8) or bytes (Uint8Array / ArrayBuffer); returns lowercase hex.
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function sha256(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input)
      : input instanceof Uint8Array ? input : new Uint8Array(input);
    const n = bytes.length, total = Math.ceil((n + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[n] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(n / 0x20000000)); // length in bits, high word
    dv.setUint32(total - 4, (n << 3) >>> 0);             // low word
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
  }

  // ---------------------------------------------------------------- maths fingerprint
  // The model calls Math.exp (Fermi imitation with K > 0) and Math.log and Math.cos (learners'
  // random steps). JavaScript engines differ in the last bit of these for some inputs, and one bit
  // can flip an imitation decision, after which the run diverges. Runs with K = 0 and no learners
  // use none of them. This hashes 3,000 results of each so a run file records which maths made it.
  function mathFingerprint() {
    const out = new Float64Array(9000);
    let s = 12345;
    const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s + 0.5) / 2147483648; };
    for (let i = 0; i < 3000; i++) {
      const u = r(), v = r();
      out[3 * i] = Math.exp(-(v - 0.5) * 40); out[3 * i + 1] = Math.log(u); out[3 * i + 2] = Math.cos(2 * Math.PI * v);
    }
    return sha256(new Uint8Array(out.buffer)).slice(0, 16);
  }
  // the fingerprint of the Node.js the committed run files and golden tests were made with (v22)
  const REFERENCE_MATH = "b3bd2ff7006626dd";

  // ---------------------------------------------------------------- experiments
  function setPath(obj, key, value) {
    const parts = key.split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = Object.assign({}, o[parts[i]]); o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
  }

  function seedsOf(spec) {
    if (Array.isArray(spec)) return spec;
    if (spec && Number.isInteger(spec.from) && Number.isInteger(spec.count)) return Array.from({ length: spec.count }, (_, i) => spec.from + i);
    if (Number.isInteger(spec)) return [spec];
    throw new Error('"seeds" must be a list, a number, or { "from": n, "count": n }');
  }

  function fmtValue(v) { return typeof v === "number" ? String(Number(v.toPrecision(6))) : String(v); }

  // Expand an experiment into tasks: every combination of the swept values, for every seed.
  // Each task's name is its sweep values and seed plus a hash of everything that decides the run.
  function expand(exp, M) {
    if (!exp.name || !/^[\w.-]+$/.test(exp.name)) throw new Error('experiment needs a "name" of letters, digits, ".", "_" or "-"');
    const generations = Math.max(0, Math.round(exp.generations ?? 1000));
    const logEvery = Math.max(1, Math.round(exp.logEvery ?? 1));
    const logDenseUntil = Math.max(0, Math.round(exp.logDenseUntil ?? 0));
    const stop = exp.stop ?? "strong";
    if (!["strong", "none"].includes(stop)) throw new Error('"stop" must be "strong" or "none"');
    const sweep = Object.entries(exp.sweep || {});
    for (const [k, vals] of sweep) if (!Array.isArray(vals) || !vals.length) throw new Error(`sweep "${k}" needs a non-empty list`);
    let combos = [[]];
    for (const [k, vals] of sweep) combos = combos.flatMap((c) => vals.map((v) => c.concat([[k, v]])));
    const tasks = [];
    for (const combo of combos) {
      for (const seed of seedsOf(exp.seeds ?? 1)) {
        let params = JSON.parse(JSON.stringify(exp.base || {}));
        for (const [k, v] of combo) setPath(params, k, v);
        params.seed = seed;
        params = M.createSim(params).S.params; // validated, complete, in a fixed key order
        const hash = sha256(JSON.stringify(Object.assign({ params, generations, logEvery, modelVersion: M.MODEL_VERSION },
          stop === "strong" ? {} : { stop }, logDenseUntil ? { logDenseUntil } : {}))).slice(0, 8); // defaults keep earlier run names
        const label = combo.map(([k, v]) => `${k}=${fmtValue(v)}`).concat([`seed=${seed}`]).join("_");
        tasks.push({ name: `${label}__${hash}`, sweep: Object.fromEntries(combo), params, generations, logEvery, logDenseUntil, stop, experiment: exp.name });
      }
    }
    return tasks;
  }

  // Generations a task logs if it runs to the end (a run that stops early logs a subset of these,
  // plus the generation it stopped at).
  function loggedGens(task) {
    const g = [0];
    for (let x = 1; x <= task.generations; x++) if (x % task.logEvery === 0 || x <= task.logDenseUntil || x === task.generations) g.push(x);
    return g;
  }

  // ---------------------------------------------------------------- one run
  // Runs one task and returns its run file (an object; the caller writes or packs it).
  // opts: { model: { file, sha256, commit, dirty, version }, runner: {...}, onProgress(g, lastRecord) }
  function runTask(task, M, opts) {
    const o = opts || {};
    const t0 = Date.now();
    const sim = M.createSim(task.params);
    sim.restart();
    const records = [sim.measure()];
    // strong convergence can end a run only when it is final: no learners, exact payoffs
    // (and "reset" history: in a continuing game one vector can still drift towards its long-run play)
    const canStop = task.stop !== "none" && sim.S.params.mode === "expected" && sim.LR.list.length === 0;
    const carry = sim.S.params.history === "carry";
    sim.S.lazyRefs = true; // reference lines only for logged generations (same values, much faster)
    let stopped = null;
    let tick = Date.now();
    for (let g = 1; g <= task.generations; g++) {
      sim.step();
      // cheap test first: one vector means one class holds every player
      if (canStop && g < task.generations && sim.S.last.cls.some((x) => x === 1) && sim.distinctCount() === 1) {
        const r = sim.measure(), last = Object.assign({}, r, { gen: task.generations });
        stopped = { reason: "strong convergence", gen: g };
        if (carry && sim.S.game === "pd") { // the games settle onto the vector's long-run play, exactly
          sim.pairStationary(sim.S.X, 0, 0);
          Object.assign(last, { coop: r.mmCoop, pay: r.mmPay, cc: sim.F[0] });
          stopped.settled = "long-run (stationary)";
        }
        records.push(r, last);
        break;
      }
      if (g % task.logEvery === 0 || g <= task.logDenseUntil || g === task.generations) records.push(sim.measure());
      if (o.onProgress && (g & 15) === 0) {
        const now = Date.now();
        if (now - tick >= 250) { tick = now; o.onProgress(g, records[records.length - 1]); }
      }
    }
    return M.buildRun({
      params: sim.S.params, generations: task.generations, logEvery: task.logEvery, records,
      survivors: sim.survivors(500),
      classes: sim.NAMED.map((n) => n.name).concat(["mixed"]), components: sim.COMP.slice(),
      meta: {
        name: task.name, experiment: task.experiment, sweep: task.sweep, model: o.model ?? null,
        runner: o.runner ?? null,
        created: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, reproducible: true, stopped,
      },
    });
  }

  return { sha256, mathFingerprint, REFERENCE_MATH, setPath, seedsOf, fmtValue, expand, loggedGens, runTask };
});
