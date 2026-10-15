#!/usr/bin/env node
// simlock-scrcpy-capture — streams the screen of one booted Android emulator on stdout.
//
// The Android counterpart of vendor/screen-capture. It is the program simlock's daemon spawns, so the
// contract below is the daemon's, not a preference:
//
//   simlock-scrcpy-capture <SERIAL> --codec avcc --fps N --bitrate BPS --max-dimension PX [--duration SEC]
//
// The wire
// --------
// stdout is the video channel and carries nothing else: every log line goes to stderr. Each frame is
// one write in serve-sim's AVCC envelope — a 4-byte big-endian length (covering the tag byte that
// follows it), then a tag, then the payload. Tags 0x01/0x02/0x03 are the description record, a key frame
// and a delta; 0x05 is this tool's JSON meta frame, written first so a relay learns the codec and the
// size before any video arrives. Key and delta payloads are 4-byte-length-prefixed AVCC NAL data — the
// exact bytes a browser VideoDecoder consumes, with no Annex-B start codes anywhere.
//
// stderr is UTF-8 text: the log, plus a `STATS <json>` line every ~5 s in the same shape the iOS tool
// writes, so an operator reads one format for both platforms.
//
// Lifecycle: capture runs until stdin closes. stdin is a liveness handle — the daemon that closes it is
// the daemon that asked for stop, whether the viewer went away or the lease ended. Teardown then removes
// the adb forward, stops the server on the device and deletes the file it pushed, because a capture that
// outlives its connection pins a device somebody else is about to lease.
//
// Environment: SIMLOCK_ADB_PATH, ANDROID_HOME / ANDROID_SDK_ROOT pick the adb binary;
// ANDROID_ADB_SERVER_PORT is inherited and decides *which* adb server — an emulator lease gets simlock's
// private one, so a run that assumed port 5037 would be talking to the wrong set of devices entirely.
//
// The protocol is scrcpy 5.0.1's own, spoken to the vendored server in ../scrcpy-server-v5.0.1; the
// conversion onto our envelope lives in ./scrcpy-stream.mjs. There is no scrcpy client here and nothing
// is fetched at runtime: the server is pushed from this repo.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TAG, createByteSource, createEnvelopeWriter, createAccessUnitEmitter, readScrcpyStream } from "./scrcpy-stream.mjs";

// why: one constant is the version of the artifact, the version string the server demands as its first
// argument, and half of the path it is loaded from. Upstream refuses to start on any mismatch, so the
// three can never be made to disagree — the filename _is_ the version.
const VERSION = "5.0.1";
const SERVER_PATH = fileURLToPath(new URL(`../scrcpy-server-v${VERSION}`, import.meta.url));

const USAGE =
  "usage: simlock-scrcpy-capture <SERIAL> [--codec avcc] [--fps N] [--bitrate BPS] [--max-dimension PX] [--duration SEC]";

// why this bound: the daemon waits 500 ms after closing stdin before it SIGKILLs, so teardown is at most
// two adb calls, issued concurrently — anything slower gets killed mid-flight and leaks what it was meant
// to clean up. The deadline bounds the *wait*, not the attempt: past it the tool reports a leak rather
// than hanging.
const TEARDOWN_DEADLINE_MS = 4_000;
const ADB_TIMEOUT_MS = 10_000;
// Depth of the envelope writer's backlog, past which a delta is dropped rather than queued. The iOS tool
// does the same with `bufferingNewest(1)`; see createEnvelopeWriter for why dropping is safe and an
// unbounded queue is not.
const BACKLOG_BYTES = 4 * 1024 * 1024;
// how long the server gets to start answering on the tunnel before this run gives up
const STREAM_DEADLINE_MS = 25_000;

function log(message) {
  process.stderr.write(`[capture] ${message}\n`);
}

// ---------------------------------------------------------------- options

function parseOptions(argv) {
  const options = { serial: "", codec: "avcc", fps: 30, bitrate: 2_000_000, maxDimension: 720, duration: 0 };
  const positionals = [];
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    const value = () => (index += 1, index < argv.length ? argv[index] : undefined);
    let number;
    switch (argument) {
      case "--codec": {
        const given = value();
        if (given === undefined) return undefined;
        options.codec = given;
        break;
      }
      case "--fps":
        number = Number(value());
        if (!Number.isFinite(number)) return undefined;
        // why the same clamps as the iOS tool: two tools that answer one flag with different ceilings
        // would make the daemon's configuration mean two things on two platforms.
        options.fps = Math.max(1, Math.min(60, Math.round(number)));
        break;
      case "--bitrate":
        number = Number(value());
        if (!Number.isFinite(number)) return undefined;
        options.bitrate = Math.max(100_000, Math.round(number));
        break;
      case "--max-dimension":
        number = Number(value());
        if (!Number.isFinite(number)) return undefined;
        options.maxDimension = Math.max(0, Math.round(number));
        break;
      case "--duration":
        number = Number(value());
        if (!Number.isFinite(number)) return undefined;
        options.duration = Math.max(0, number);
        break;
      default:
        if (argument.startsWith("--")) return undefined;
        positionals.push(argument);
    }
    index += 1;
  }
  // why "wherever it is not a flag value": the daemon appends the device address after its own flags, so
  // the serial must be readable from any position.
  if (positionals.length !== 1) return undefined;
  options.serial = positionals[0];
  return options;
}

const options = parseOptions(process.argv.slice(2));
if (options === undefined) {
  log(USAGE);
  process.exit(2);
}
// why refused rather than ignored: this tool only drives scrcpy's H.264 encoder. An mjpeg ask would
// otherwise be answered with a stream whose meta says h264, and a viewer handed the wrong codec fails
// somewhere far away from the reason.
if (options.codec !== "avcc") {
  log(`simlock-scrcpy-capture only writes H.264/AVCC, not --codec ${options.codec}\n${USAGE}`);
  process.exit(2);
}
if (!existsSync(SERVER_PATH)) {
  log(`the vendored scrcpy server for ${VERSION} is not at ${SERVER_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------- adb

function resolveAdb() {
  if (process.env.SIMLOCK_ADB_PATH) return process.env.SIMLOCK_ADB_PATH;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) return `${sdk}/platform-tools/adb`;
  return "adb";
}

const ADB = resolveAdb();
// why the port is only ever inherited, never defaulted: the emulator lives on simlock's private adb
// server, which the driver chooses per lease. Naming a server here would silently talk to a different
// device list, and two device lists that both contain `emulator-5586` is how a capture films the wrong
// phone.
const ADB_ENV = process.env;

function adb(args, { timeoutMs = ADB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, ["-s", options.serial, ...args], { env: ADB_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`adb ${args.join(" ")} did not answer within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`adb ${args.join(" ")} -> exit ${String(code)}: ${err || out}`));
    });
  });
}

// Long-lived call — the device-side server itself — so the handle is the caller's to kill.
function adbHandle(args) {
  const child = spawn(ADB, ["-s", options.serial, ...args], { env: ADB_ENV, stdio: ["ignore", "pipe", "pipe"] });
  // why the server's own words are echoed: when it refuses to start, the only symptom on our side is a
  // socket that closes, which would otherwise be reported as a protocol failure rather than the bad
  // option or the version mismatch that actually caused it.
  child.stdout?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

// ---------------------------------------------------------------- envelope + stats

const source = createByteSource();

const envelope = createEnvelopeWriter({
  write: (frame) => process.stdout.write(frame),
  maxQueuedBytes: BACKLOG_BYTES,
});
process.stdout.on("drain", () => envelope.drain());
process.stdout.on("error", (error) => {
  // EPIPE is the viewer going away, which is the normal end of a stream.
  log(`stdout closed (${error.message})`);
  void stop("stdout closed", pictures() === 0 ? 1 : 0);
});

const emitter = createAccessUnitEmitter({ emit: (tag, payload) => envelope.emit(tag, payload) });

const startedAt = Date.now();
let windowStart = startedAt;
let windowFrames = 0;
let windowBytes = 0;

/** Frames that carry a picture — the meta frame is not one, and a run that wrote only meta produced nothing. */
function pictures() {
  return Math.max(0, envelope.state.frames - 1);
}

function tick() {
  const now = Date.now();
  const secs = (now - windowStart) / 1000;
  if (secs < 5) return;
  const { frames, bytes } = envelope.state;
  log(
    `STATS ${JSON.stringify({
      fps: Math.round((frames - windowFrames) / secs * 10) / 10,
      kbps: Math.round(((bytes - windowBytes) * 8) / 1000 / secs),
      totalFrames: frames,
      totalBytes: bytes,
      avgKbps: Math.round((bytes * 8) / 1000 / Math.max((now - startedAt) / 1000, 0.001)),
      rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
    })}`,
  );
  windowStart = now;
  windowFrames = frames;
  windowBytes = bytes;
}

// why a timer as well as the per-packet call: an idle encoder emits almost nothing, and a stream that is
// quietly measuring 1 fps is exactly the state an operator needs to see — a log that only reports when
// frames arrive cannot tell "idle" from "stuck".
setInterval(tick, 1_000).unref();

// ---------------------------------------------------------------- lifecycle
// why teardown is ordered this way: destroying the socket is what actually stops the device and it is
// synchronous, so it happens before anything is awaited — the daemon's SIGKILL can arrive at any moment
// and must not be able to catch us before it. The adb calls after it clear state we created.

let serverProcess;
let socket;
let localPort;
let remoteJar;
let stopping;

function stopSynchronously() {
  if (stopping) return;
  stopping = true;
  try {
    socket?.destroy();
  } catch {
    /* the socket is going away regardless */
  }
  serverProcess?.kill("SIGKILL");
  socket = undefined;
  serverProcess = undefined;
  source.end();
}

// why the brackets: `pkill -f` also reads the command line of the very shell that runs it, so a plain jar
// name matches that shell too and the pkill kills the teardown before its own `rm` can run. One
// bracketed character is still the same pattern for the server's command line and no longer matches this
// one.
function maskedName(name) {
  return `${name.slice(0, -1)}[${name.slice(-1)}]`;
}

async function teardown() {
  if (remoteJar === undefined) return;
  const masked = maskedName(remoteJar.split("/").pop());
  const results = await Promise.allSettled([
    // why one shell command: the device-side server and the file it was pushed as are cleaned in a single
    // round trip, and the glob form of `rm` keeps the jar's real name out of this command line so the
    // pkill above cannot match it.
    adb(["shell", `pkill -f '${masked}' || true; rm -f ${masked}; echo cleaned`], { timeoutMs: 3_000 }),
    adb(["forward", "--remove", `tcp:${String(localPort)}`], { timeoutMs: 3_000 }),
  ]);
  const device = results[0];
  if (device.status === "fulfilled") log("server stopped on the device, pushed file removed");
  else log(`LEAKED: the device server and pushed file did not clean up (${device.reason.message})`);
  const forward = results[1];
  if (forward.status === "fulfilled") log(`forward tcp:${String(localPort)} removed`);
  else log(`LEAKED: forward tcp:${String(localPort)} still installed (${forward.reason.message})`);
}

/** @returns never — exits with 0 only for a stop that was asked for and produced a picture. */
async function stop(reason, exitCode) {
  stopSynchronously();
  const secs = Math.max((Date.now() - startedAt) / 1000, 0.001);
  log(`stop (${reason}) after ${secs.toFixed(1)}s`);
  log(
    `RESULT ${JSON.stringify({
      seconds: Math.round(secs * 100) / 100,
      frames: pictures(),
      bytes: envelope.state.bytes,
      fps: Math.round((pictures() / secs) * 10) / 10,
      kbps: Math.round((envelope.state.bytes * 8) / 1000 / secs),
      dropped: envelope.state.dropped,
      codec: emitter.codecString ?? "none",
    })}`,
  );
  let timer;
  await Promise.race([
    teardown().catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, TEARDOWN_DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  // why stdout is drained before exiting: the last frames of a stream are the ones a viewer is still
  // watching, and process.exit drops whatever is still buffered. It matters whenever stdout is a file or
  // a pipe nobody is reading fast, which is exactly how this tool gets tested.
  await new Promise((resolve) => {
    if (process.stdout.writableFinished || process.stdout.writableEnded) return resolve();
    process.stdout.end(resolve);
  });
  process.exit(exitCode);
}

// ---------------------------------------------------------------- main

function attempt(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const attemptSocket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      attemptSocket.destroy();
      reject(new Error(`no bytes within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const onData = (chunk) => {
      clearTimeout(timer);
      attemptSocket.removeListener("error", onError);
      attemptSocket.removeListener("end", onEnd);
      socket = attemptSocket;
      socket.on("data", source.push);
      socket.on("error", (error) => source.end(error));
      socket.on("end", () => source.end());
      resolve(chunk);
    };
    const onError = (error) => {
      clearTimeout(timer);
      attemptSocket.destroy();
      reject(error);
    };
    const onEnd = () => onError(new Error("the device closed the socket"));
    attemptSocket.once("data", onData);
    attemptSocket.once("error", onError);
    attemptSocket.once("end", onEnd);
  });
}

// why the retries: `adb forward` completes the host-side TCP connection whether or not anything is
// listening on the device's abstract socket yet, so a single connect appears to succeed and then yields
// an empty stream forever — the exact trap scrcpy's dummy byte exists to catch, which is turned off here.
// Only bytes are evidence of a stream. Each failed attempt tears its socket down completely and starts
// over, because a half-delivered header would leave the parser out of step.
async function connectUntilStreaming() {
  const deadline = Date.now() + STREAM_DEADLINE_MS;
  let last;
  for (let tries = 0; Date.now() < deadline; tries += 1) {
    try {
      const first = await attempt(localPort, 2_000);
      source.push(first);
      if (tries > 0) log(`connected on attempt ${String(tries + 1)}`);
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`the device never streamed: ${last?.message}`);
}

async function main() {
  log(
    `adb ${ADB}${process.env.ANDROID_ADB_SERVER_PORT ? ` (server port ${process.env.ANDROID_ADB_SERVER_PORT})` : " (default server)"}`,
  );

  // why a name nothing else would use, with this process in it: several captures can run on one host and a
  // fixed name would have them push over, or delete, each other's server.
  const jarName = `simlock-scrcpy-${String(process.pid)}-${Math.random().toString(16).slice(2, 8)}.jar`;
  remoteJar = `/data/local/tmp/${jarName}`;
  log(`pushing the scrcpy server ${VERSION} to ${remoteJar}`);
  await adb(["push", SERVER_PATH, remoteJar], { timeoutMs: 30_000 });

  // why port 0: the host port is adb's to choose, so two captures on one host cannot select the same one
  // and tear down one another's tunnel. `adb forward tcp:0` answers with the port it picked.
  const assigned = await adb(["forward", "tcp:0", "localabstract:scrcpy"]);
  localPort = Number(assigned);
  if (!Number.isInteger(localPort) || localPort <= 0) {
    throw new Error(`adb did not report a forward port (got ${JSON.stringify(assigned)})`);
  }
  log(`forward tcp:${String(localPort)} -> localabstract:scrcpy`);

  // why these exact flags: send_frame_meta and send_stream_meta stay ON rather than using
  // raw_stream=true, because the codec id, the per-session geometry and the key/config flags are
  // precisely what our envelope needs — raw_stream strips all of them. cleanup=false is a safety
  // requirement: cleanup=true writes persistent Android settings on a leased device.
  const serverOptions = [
    "tunnel_forward=true",
    "audio=false",
    "control=false",
    "cleanup=false",
    "send_device_meta=false",
    "send_dummy_byte=false",
    "send_frame_meta=true",
    "send_stream_meta=true",
    "video_codec=h264",
    `max_fps=${String(options.fps)}`,
    `video_bit_rate=${String(options.bitrate)}`,
  ];
  if (options.maxDimension > 0) serverOptions.push(`max_size=${String(options.maxDimension)}`);

  // why the server starts before we connect: see connectUntilStreaming.
  serverProcess = adbHandle([
    "shell",
    `CLASSPATH=${remoteJar} app_process / com.genymobile.scrcpy.Server ${VERSION} ${serverOptions.join(" ")}`,
  ]);

  await connectUntilStreaming();
  if (options.duration > 0) {
    // why a timer rather than a deadline checked in the read loop: on a still screen the encoder emits
    // almost nothing, so the loop sits inside need() waiting for a header that never arrives.
    setTimeout(
      () => source.end(Object.assign(new Error("the capture window ended"), { end: true })),
      options.duration * 1000,
    );
  }

  const { stats, codec } = await readScrcpyStream({
    source,
    onMeta: ({ width, height }) => {
      // why these names: the daemon answers its stream headers from this frame, and they are the names the
      // iOS tool already writes — one reader for both platforms.
      const meta = { udid: options.serial, codec: "h264", width, height, fps: options.fps, platform: "android" };
      log(`ready ${JSON.stringify(meta)}`);
      envelope.emit(TAG.meta, Buffer.from(JSON.stringify(meta), "utf8"));
    },
    onPacket: ({ payload, isConfig, isKey }) => {
      const result = emitter.mediaPacket(payload, isConfig, isKey);
      if (result.written === 0) log(result.reason);
      tick();
    },
  });
  log(
    `stream closed: ${codec.name} ${String(stats.frames)} media packets, ${String(stats.keyframes)} key, ` +
      `${String(stats.configPackets)} config, ${String(stats.sessions)} session`,
  );
}

// stdin is the stop: the daemon that closes it is the daemon that asked for the stream to end, whether the
// viewer went away or the lease did. Nothing else is required to make a capture stop, and nothing else may
// keep one alive.
let stdinClosed = false;
function onStdinClosed() {
  if (stdinClosed) return;
  stdinClosed = true;
  log("stdin closed");
  void stop("stdin closed", pictures() === 0 ? 1 : 0);
}
process.stdin.on("end", onStdinClosed);
process.stdin.on("close", onStdinClosed);
process.stdin.resume();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => void stop(signal, pictures() === 0 ? 1 : 0));
}

process.on("uncaughtException", (error) => {
  log(`uncaught: ${error?.stack ?? String(error)}`);
  void stop("uncaught error", 1);
});

main().then(
  () => void stop("the stream ended", pictures() === 0 ? 1 : 0),
  (error) => {
    log(`FAILED: ${error?.message}`);
    void stop("failure", 1);
  },
);
