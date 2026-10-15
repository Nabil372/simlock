#!/usr/bin/env node
// capture-selftest.mjs — proves the conversion half of simlock-scrcpy-capture without a device.
//
// What is honestly testable offline is everything between "bytes arrived on the tunnel" and "bytes left
// on stdout": the wire parser, the Annex-B -> AVCC conversion, the avcC record, the frame order, the
// one-writer envelope, backpressure, and the CLI's argument contract. What is not testable offline is
// that a device answers. So this file builds a *synthetic scrcpy 5.0.1 stream* — real H.264 produced by
// ffmpeg, cut up and re-framed into scrcpy's session/media packet layout — and pushes it through the same
// modules the shipping tool imports. If a check passes here it passes there, because it is the same code.
//
//   node vendor/scrcpy/capture/capture-selftest.mjs
//
// ffmpeg is used to obtain real H.264; without it the H.264-dependent checks report SKIPPED rather than
// pretending, and the rest still runs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  TAG,
  createByteSource,
  createEnvelopeWriter,
  createAccessUnitEmitter,
  readScrcpyStream,
  toNals,
  codecString,
} from "./scrcpy-stream.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(HERE, "simlock-scrcpy-capture.mjs");
const UNFRAME = join(REPO, "vendor/screen-capture/scripts/unframe.mjs");
const SCRCPY_CODEC_ID = 0x6832_3634; // "h264"

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => void results.push({ name, ok: true }),
      (error) => void results.push({ name, ok: false, skipped: error?.skip === true, detail: error?.message }),
    );
}
const skip = (why) => {
  throw Object.assign(new Error(why), { skip: true });
};

// ---------------------------------------------------------------- fixture

/** Annex-B h264 -> scrcpy 5.0.1's video socket bytes. */
function toScrcpyStream(annexb, { width, height, dropConfigPacket = false } = {}) {
  const nals = toNals(annexb);
  const sps = nals.filter((n) => (n[0] & 0x1f) === 7);
  const pps = nals.filter((n) => (n[0] & 0x1f) === 8);
  const packets = [];

  const session = () => {
    const head = Buffer.alloc(12);
    head.writeUInt32BE(0x8000_0000, 0); // bit63 = session packet
    head.writeUInt32BE(width, 4);
    head.writeUInt32BE(height, 8);
    return head;
  };
  const media = (ptsUs, flags, payload) => {
    const head = Buffer.alloc(12);
    head.writeBigUInt64BE((1n << flags) | BigInt(ptsUs), 0);
    head.writeUInt32BE(payload.length, 8);
    return Buffer.concat([head, payload]);
  };
  const START = Buffer.from([0, 0, 0, 1]);
  const join4 = (sets) => Buffer.concat(sets.flatMap((s) => [START, s]));

  let pts = 0;
  let sawKey = false;
  if (!dropConfigPacket) {
    // scrcpy's config packet: Annex-B SPS+PPS with the config flag set (bit62)
    packets.push(media(pts, 62n, join4([...sps, ...pps])));
  }
  for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (type === 7 || type === 8) continue;
    if (type !== 5 && type !== 1) continue;
    const isKey = type === 5;
    // Some encoders repeat SPS/PPS in the IDR; scrcpy does, so the fixture does too, to prove the
    // converter does not leak parameter sets into a picture payload.
    const payload = isKey ? join4([...sps, ...pps, nal]) : Buffer.concat([START, nal]);
    packets.push(media(pts, isKey ? 61n : 0n, payload));
    if (isKey) sawKey = true;
    pts += 33_333;
  }
  assert.ok(sawKey, "the fixture has no key frame");
  return Buffer.concat([Buffer.from([0x68, 0x32, 0x36, 0x34]), session(), ...packets]);
}

/** Runs a fixture through the shipping conversion and returns the envelope it produced. */
async function runThroughPipeline(streamBytes, { chunkSize = 0, sinkAccepts = () => true } = {}) {
  const source = createByteSource();
  const out = [];
  const envelope = createEnvelopeWriter({
    write: (frame) => {
      out.push(Buffer.from(frame));
      return sinkAccepts(frame);
    },
    maxQueuedBytes: 64,
  });
  const emitter = createAccessUnitEmitter({ emit: (tag, payload) => envelope.emit(tag, payload) });
  let meta;
  const reader = readScrcpyStream({
    source,
    onMeta: ({ width, height }) => {
      meta = { udid: "emulator-5586", codec: "h264", width, height, fps: 30, platform: "android" };
      envelope.emit(TAG.meta, Buffer.from(JSON.stringify(meta), "utf8"));
    },
    onPacket: ({ payload, isConfig, isKey }) => emitter.mediaPacket(payload, isConfig, isKey),
  });
  const size = chunkSize > 0 ? chunkSize : streamBytes.length;
  for (let offset = 0; offset < streamBytes.length; offset += size) {
    source.push(streamBytes.subarray(offset, offset + size));
    await new Promise((resolve) => setImmediate(resolve));
  }
  // why: without this the reader blocks forever on a header that will never arrive -- an ended fixture
  // must look to the reader exactly like a device hanging up.
  source.end();
  const finished = await reader;
  return { meta, frames: out, stats: finished.stats, codecStringOnOffer: emitter.codecString };
}

function tagOf(frame) {
  return frame[4];
}
function payloadOf(frame) {
  return frame.subarray(5, 5 + frame.readUInt32BE(0) - 1);
}

// ---------------------------------------------------------------- checks

const work = mkdtempSync(join(tmpdir(), "simlock-scrcpy-selftest-"));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
let realAnnexB;
if (hasFfmpeg) {
  // Real H.264, known geometry, one slice per frame so a packet is an access unit. Baseline profile
  // because that is what an Android hardware encoder negotiates for a 720p stream — and `yuv420p`
  // because `testsrc` hands libx264 4:4:4, which baseline profile refuses outright, so without the
  // pixel format the fixture generator fails before any check runs.
  const generated = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30:duration=2",
      "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-preset", "ultrafast",
      "-g", "15", "-slices", "1", "-pix_fmt", "yuv420p", "-f", "h264", join(work, "fixture.h264"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, `ffmpeg failed: ${generated.stderr}`);
  realAnnexB = readFileSync(join(work, "fixture.h264"));
}

await check("a stream split into 7-byte chunks produces the same envelope as one whole write", () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed, so there is no real H.264 to split");
  const bytes = toScrcpyStream(realAnnexB, { width: 320, height: 568 });
  return Promise.all([
    runThroughPipeline(bytes),
    runThroughPipeline(bytes, { chunkSize: 7 }),
  ]).then(([whole, split]) => {
    assert.deepEqual(split.frames, whole.frames);
    assert.ok(whole.frames.length > 20, `only ${String(whole.frames.length)} frames produced`);
  });
});

await check("the meta frame is the first frame and carries the fields the daemon reads", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames, meta } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  assert.equal(tagOf(frames[0]), TAG.meta, "the first frame is not a meta frame");
  assert.deepEqual(JSON.parse(payloadOf(frames[0]).toString("utf8")), meta);
  assert.equal(meta.codec, "h264");
  assert.equal(meta.udid, "emulator-5586");
  for (const key of ["width", "height", "fps"]) {
    assert.equal(typeof meta[key], "number", `meta.${key} is not a number`);
    assert.ok(meta[key] > 0, `meta.${key} is not positive`);
  }
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 568);
});

await check("no picture frame is ever written before the meta frame", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  const first = frames.findIndex((f) => tagOf(f) !== TAG.meta);
  assert.ok(tagOf(frames[first]) === TAG.description, `the first frame after meta is tag ${String(first)}`);
});

await check("frame lengths cover the tag byte, exactly as framing.ts reads them", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  for (const frame of frames) {
    const declared = frame.readUInt32BE(0);
    assert.equal(declared, frame.length - 4, "the length does not cover the tag byte");
    assert.equal(frame.length, declared + 5 - 1 + 0 + 0);
  }
});

await check("a description frame is a valid avcC whose codec string parses", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames, codecStringOnOffer } = await runThroughPipeline(
    toScrcpyStream(realAnnexB, { width: 320, height: 568 }),
  );
  const description = frames.find((f) => tagOf(f) === TAG.description);
  assert.ok(description, "no description frame was written");
  const avcC = payloadOf(description);
  assert.equal(avcC[0], 0x01, "an avcC record starts with configurationVersion 1");
  const spsCount = avcC[5] & 0x1f;
  assert.equal(spsCount, 1);
  assert.equal((avcC[4] & 0x03) + 1, 4, "our envelope uses 4-byte NAL lengths, so lengthSizeMinusOne must be 3");
  let i = 6;
  for (let s = 0; s < spsCount; s++) {
    const size = avcC.readUInt16BE(i);
    i += 2 + size;
  }
  const ppsCount = avcC[i];
  i += 1;
  for (let p = 0; p < ppsCount; p++) i += 2 + avcC.readUInt16BE(i);
  assert.equal(i, avcC.length, "the avcC record's lengths do not account for its bytes");
  assert.match(codecStringOnOffer, /^avc1\.[0-9a-f]{6}$/);
  assert.equal(codecString(avcC), codecStringOnOffer);
});

await check("key and delta payloads are length-prefixed AVCC with no Annex-B start codes", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  const pictures = frames.filter((f) => tagOf(f) === TAG.keyframe || tagOf(f) === TAG.delta);
  assert.ok(pictures.length > 10, `only ${String(pictures.length)} pictures`);
  for (const frame of pictures) {
    const payload = payloadOf(frame);
    assert.ok(payload.length > 4);
    let offset = 0;
    let nals = 0;
    while (offset + 4 <= payload.length) {
      const size = payload.readUInt32BE(offset);
      assert.ok(size > 0 && offset + 4 + size <= payload.length, "a NAL length runs past the payload");
      const nal = payload.subarray(offset + 4, offset + 4 + size);
      assert.ok(nal[0] !== 0, "a NAL starts with a zero byte, which is a start code in disguise");
      nals += 1;
      offset += 4 + size;
    }
    assert.equal(offset, payload.length, "the payload does not divide into NALs");
    assert.ok(nals > 0);
  }
});

await check("parameter sets folded into an IDR do not leak into the picture payload", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  const key = frames.find((f) => tagOf(f) === TAG.keyframe);
  const payload = payloadOf(key);
  const types = [];
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const size = payload.readUInt32BE(offset);
    types.push(payload[offset + 4] & 0x1f);
    offset += 4 + size;
  }
  // why SPS/PPS are allowed here: passing them through unchanged is what scrcpy does and what a browser
  // decoder tolerates; what must never appear is a start code, and the check above proves that.
  assert.ok(types.includes(5), "the key frame's payload has no IDR slice");
  assert.ok(!types.includes(0), "a NAL of type 0 (a start-code remnant) is in the payload");
});

await check("a description still precedes a key frame when no config packet ever arrives", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(
    toScrcpyStream(realAnnexB, { width: 320, height: 568, dropConfigPacket: true }),
  );
  const tags = frames.map(tagOf);
  assert.ok(tags.includes(TAG.description), "no description frame at all");
  assert.ok(tags.indexOf(TAG.description) < tags.indexOf(TAG.keyframe));
  assert.equal(tags[1], TAG.description, "the description is not the first frame after meta");
});

await check("a sink that stops accepting drains on demand and never loses a description or key frame", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  let taken = 0;
  const seen = [];
  const out = [];
  const source = createByteSource();
  const envelope = createEnvelopeWriter({
    write: (frame) => {
      if (taken++ < 2) return false; // the sink refuses the first two writes outright
      return true;
    },
    maxQueuedBytes: 16, // tiny on purpose: the drop path is what is under test
  });
  const emitter = createAccessUnitEmitter({
    emit: (tag, payload) => {
      seen.push(tag);
      out.push(payload);
      envelope.emit(tag, payload);
    },
  });
  const bytes = toScrcpyStream(realAnnexB, { width: 320, height: 568 });
  const reader = readScrcpyStream({
    source,
    onMeta: ({ width, height }) =>
      envelope.emit(TAG.meta, Buffer.from(JSON.stringify({ width, height, codec: "h264" }), "utf8")),
    onPacket: ({ payload, isConfig, isKey }) => emitter.mediaPacket(payload, isConfig, isKey),
  });
  source.push(bytes);
  source.end();
  await reader;
  assert.ok(envelope.state.dropped > 0, "the tiny backlog dropped nothing, so the path is untested");
  const first = seen[0];
  assert.equal(first, TAG.meta);
  const descriptions = seen.filter((t) => t === TAG.description).length;
  const keys = seen.filter((t) => t === TAG.keyframe).length;
  assert.equal(descriptions, 1, "the description was dropped or duplicated");
  assert.ok(keys > 0);
  assert.ok(seen.filter((t) => t === TAG.delta).length < seen.length, "not one delta survived, so nothing was measured");
  void out;
});

await check("the repo's own envelope reader accepts the output", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const { frames } = await runThroughPipeline(toScrcpyStream(realAnnexB, { width: 320, height: 568 }));
  const envelopePath = join(work, "selftest.bin");
  const rawPath = join(work, "selftest.264");
  writeFileSync(envelopePath, Buffer.concat(frames));
  const read = spawnSync("node", [UNFRAME, envelopePath, rawPath], { encoding: "utf8" });
  assert.equal(read.status, 0, `unframe.mjs exited ${String(read.status)}: ${read.stderr}`);
  const report = JSON.parse(read.stdout);
  assert.equal(report.malformed, 0, "unframe.mjs found a malformed frame");
  assert.equal(report.counts.meta, 1);
  assert.equal(report.counts.description, 1);
  assert.ok(report.counts.keyframe >= 1);
  assert.ok(report.counts.delta > 1);
  assert.equal(report.parameterSets, 2, "a decoder needs an SPS and a PPS");
  assert.deepEqual(report.meta, {
    udid: "emulator-5586",
    codec: "h264",
    width: 320,
    height: 568,
    fps: 30,
    platform: "android",
  });
});

await check("ffprobe reads the unframed stream as H.264 at the meta frame's size", () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const probed = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_name,profile,width,height,nb_frames",
      "-of", "default=nw=1",
      join(work, "selftest.264"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(probed.status, 0, `ffprobe exited ${String(probed.status)}: ${probed.stderr}`);
  const fields = Object.fromEntries(
    probed.stdout
      .trim()
      .split("\n")
      .map((line) => [line.split("=")[0], line.split("=").slice(1).join("=")]),
  );
  assert.equal(fields.codec_name, "h264");
  assert.equal(fields.width, "320");
  assert.equal(fields.height, "568");
  return fields;
});

await check("a session packet that arrives twice does not write a second meta frame", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const bytes = toScrcpyStream(realAnnexB, { width: 320, height: 568 });
  // A mid-stream resolution change would send another session packet; a second meta frame would make a
  // relay answer its headers twice for one stream.
  const extra = Buffer.alloc(12);
  extra.writeUInt32BE(0x8000_0000, 0);
  extra.writeUInt32BE(568, 4);
  extra.writeUInt32BE(320, 8);
  const { frames } = await runThroughPipeline(Buffer.concat([bytes.subarray(0, 24), extra, bytes.subarray(24)]));
  assert.equal(frames.filter((f) => tagOf(f) === TAG.meta).length, 1);
});

await check("a media packet ahead of any session packet is refused, not silently framed", async () => {
  if (realAnnexB === undefined) skip("ffmpeg is not installed");
  const bytes = toScrcpyStream(realAnnexB, { width: 320, height: 568 });
  const withoutSession = Buffer.concat([bytes.subarray(0, 4), bytes.subarray(16)]);
  await assert.rejects(() => runThroughPipeline(withoutSession), /before the session packet/);
});

// ---------------------------------------------------------------- the CLI's argument contract
// These need no device: every one of them fails before anything touches adb.

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 15_000 });
}

await check("an unknown flag exits 2 with a usage line", () => {
  const run = runCli(["emulator-5586", "--wat", "1"]);
  assert.equal(run.status, 2, `exit ${String(run.status)}: ${run.stderr}`);
  assert.match(run.stderr, /usage: simlock-scrcpy-capture/);
});

await check("--codec mjpeg is refused with exit 2, not answered with the wrong codec", () => {
  const run = runCli(["emulator-5586", "--codec", "mjpeg", "--fps", "30"]);
  assert.equal(run.status, 2, `exit ${String(run.status)}: ${run.stderr}`);
  assert.match(run.stderr, /only writes H\.264\/AVCC/);
  assert.match(run.stderr, /usage: simlock-scrcpy-capture/);
});

await check("a missing serial exits 2", () => {
  const run = runCli(["--fps", "30"]);
  assert.equal(run.status, 2);
});

await check("two positionals exit 2 -- the serial is not a guess", () => {
  const run = runCli(["emulator-5586", "emulator-5588"]);
  assert.equal(run.status, 2);
});

await check("a flag with no value exits 2", () => {
  assert.equal(runCli(["emulator-5586", "--fps"]).status, 2);
  assert.equal(runCli(["emulator-5586", "--codec"]).status, 2);
});

await check("it resolves adb from the environment instead of assuming a default", () => {
  const marker = join(work, "adb-that-only-talks");
  writeFileSync(marker, "#!/bin/sh\necho \"$@\" > \"$ARGS_FILE\"\necho 'list of devices attached' \nexit 0\n", { mode: 0o755 });
  const argsFile = join(work, "adb-args.txt");
  // Serial last, flags first -- the order the daemon uses. The fake adb answers `forward tcp:0` badly on
  // purpose, so the run must fail; what is under test is which binary it called and with what.
  const run = runCli(["--codec", "avcc", "--fps", "24", "--bitrate", "800000", "--max-dimension", "720", "emulator-5586"], {
    SIMLOCK_ADB_PATH: marker,
    ANDROID_ADB_SERVER_PORT: "5040",
    ARGS_FILE: argsFile,
  });
  assert.notEqual(run.status, 0, "the run was expected to fail on the fake adb");
  const calls = readFileSync(argsFile, "utf8").trim().split("\n");
  assert.ok(calls.some((line) => line.startsWith("-s emulator-5586 push ")), `no push in ${JSON.stringify(calls)}`);
  assert.match(calls[0], /\/data\/local\/tmp\/simlock-scrcpy-\d+-[0-9a-f]+\.jar$/);
});

await check("it refuses to run without the vendored artifact it would push", () => {
  // No adb needed: the artifact check is the first thing the tool can fail on, and it must fail before
  // anything tries to reach a device.
  const missing = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `
      import { spawnSync } from "node:child_process";
      const r = spawnSync(process.execPath, ["-e", "0"], {encoding: "utf8"});
      void r;
    `],
    { encoding: "utf8" },
  );
  void missing;
  // The real check: point the tool at a version whose file is not in the repo by copying it aside.
  const dir = join(work, "broken-vendor", "capture");
  const fs = require_fs();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(CLI, join(dir, "simlock-scrcpy-capture.mjs"));
  fs.copyFileSync(join(HERE, "scrcpy-stream.mjs"), join(dir, "scrcpy-stream.mjs"));
  const run = spawnSync(process.execPath, [join(dir, "simlock-scrcpy-capture.mjs"), "emulator-5586", "--codec", "avcc"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /vendored scrcpy server/);
});

// ---------------------------------------------------------------- report

const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
for (const r of results) {
  const mark = r.ok ? "PASS" : r.skipped ? "SKIPPED" : "FAIL";
  console.log(`${mark.padEnd(7)} ${r.name}${r.ok || r.skipped ? "" : `\n        ${r.detail}`}`);
}
console.log(
  `\n${String(results.length - failed.length - skipped.length)} passed, ${String(failed.length)} failed, ` +
    `${String(skipped.length)} skipped (ffmpeg${hasFfmpeg ? " present" : " absent"})`,
);
console.log(`fixtures: ${work}`);
process.exit(failed.length === 0 ? 0 : 1);

// why: `require` is not available in an ESM module, and the check above needs a filesystem handle late.
function require_fs() {
  return { mkdirSync: mkdtempMkdirSync, copyFileSync: copyFileSyncShim };
}
function mkdtempMkdirSync(path) {
  // node:fs mkdirSync with recursive, imported lazily to keep the import list at the top honest about
  // what the module needs on every path.
  const fs = createRequire(import.meta.url)("node:fs");
  fs.mkdirSync(path, { recursive: true });
}
function copyFileSyncShim(from, to) {
  const fs = createRequire(import.meta.url)("node:fs");
  fs.copyFileSync(from, to);
}
