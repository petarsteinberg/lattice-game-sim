/*
 * Lattice Game Sim: experiment designer worker. Runs one task at a time with the same model.js and
 * runner.js as the command-line runner, then packs the run file for the results zip: the JSON text,
 * its CRC-32, and the bytes deflated (or stored, where the browser cannot compress).
 *
 * In:  { type: "run", task, model, runner }
 * Out: { type: "progress", name, g, coop }  every ~250 ms while running
 *      { type: "done", name, summary, file: { bytes, crc, size, method } }
 *      { type: "failed", name, error }
 */
/* global LatticeModel, LatticeRunner */
"use strict";
importScripts("model.js", "runner.js");

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) { return null; }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== "run") return;
  const { task } = m;
  try {
    const run = LatticeRunner.runTask(task, LatticeModel, {
      model: m.model, runner: m.runner,
      onProgress: (g, rec) => self.postMessage({ type: "progress", name: task.name, g, coop: rec ? rec.coop : null }),
    });
    const text = JSON.stringify(run);
    const raw = new TextEncoder().encode(text);
    const crc = crc32(raw);
    const z = await deflate(raw);
    const file = z && z.length < raw.length ? { bytes: z, crc, size: raw.length, method: 8 } : { bytes: raw, crc, size: raw.length, method: 0 };
    // what the page needs for the live plot and table (the full file stays packed)
    const s = run.series;
    const summary = {
      name: task.name, sweep: task.sweep, classes: run.classes, seconds: run.seconds, stopped: run.stopped,
      gen: s.gen, coop: s.coop, cc: s.cc || null, cls: s.cls,
      final: { coop: run.final.coop, cc: run.final.cc ?? null, distinct: run.final.distinct },
    };
    self.postMessage({ type: "done", name: task.name, summary, file }, [file.bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: "failed", name: task.name, error: (err && err.stack) || String(err) });
  }
};
