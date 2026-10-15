// scrcpy-stream.mjs — scrcpy's 5.0.1 video wire -> simlock's capture envelope.
//
// This is the whole translation, in one place and with no adb, no stdout and no process exits in it,
// so the same code that ships is the code `capture-selftest.mjs` runs a recorded stream through.
// simlock-scrcpy-capture.mjs owns the device and the lifecycle; this file owns the bytes.
//
// Wire facts, from scrcpy 5.0.1's own protocol:
//   video socket: codec id u32, then session packets (bit63 marker + width u32 + height u32) and media
//   packets (ptsAndFlags u64 + size u32 + payload). bit63 session marker, bit62 config, bit61 key
//   frame, bits 60..0 PTS in microseconds. A media packet is whatever does NOT have bit63 set.
//
// Format facts:
//   scrcpy's H.264 payload is Annex-B (start codes); our envelope and our browser decoder are AVCC (an
//   `avcC` description record plus 4-byte length prefixes), so every packet passes through here.

export const TAG = { description: 0x01, keyframe: 0x02, delta: 0x03, seed: 0x04, meta: 0x05 };

// ---------------------------------------------------------------- byte source
// Every field is awaited from one queue, so a packet split across TCP segments cannot desynchronise
// the parser.

export function createByteSource() {
  let pending = Buffer.alloc(0);
  let ended;
  const waiters = [];

  function wake(waiter) {
    if (pending.length >= waiter.need) {
      const chunk = pending.subarray(0, waiter.need);
      pending = pending.subarray(waiter.need);
      waiter.resolve(Buffer.from(chunk));
      return true;
    }
    return false;
  }

  return {
    push(chunk) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (waiters.length > 0 && wake(waiters.shift())) {
        /* hand out as much of the queue as it can satisfy */
      }
    },
    end(error) {
      ended = error ?? Object.assign(new Error("end of stream"), { end: true });
      for (const waiter of waiters) waiter.reject(ended);
      waiters.length = 0;
    },
    need(count) {
      if (pending.length >= count) {
        const chunk = pending.subarray(0, count);
        pending = pending.subarray(count);
        return Promise.resolve(Buffer.from(chunk));
      }
      // why: a reader that starts after the source already ended must fail rather than wait for bytes
      // that exist only in the past, so the end is remembered rather than delivered once.
      if (ended !== undefined) return Promise.reject(ended);
      return new Promise((resolve, reject) => waiters.push({ need: count, resolve, reject }));
    },
  };
}

// ---------------------------------------------------------------- Annex-B -> AVCC

/** Annex-B -> NAL list. Handles 3- and 4-byte start codes. */
export function toNals(annexb) {
  const nals = [];
  let i = 0;
  const start = (at) =>
    annexb[at] === 0 && annexb[at + 1] === 0 && (annexb[at + 2] === 1 || (annexb[at + 2] === 0 && annexb[at + 3] === 1));
  const codeLen = (at) => (annexb[at + 2] === 1 ? 3 : 4);
  while (i < annexb.length) {
    if (!start(i)) {
      i += 1;
      continue;
    }
    const from = i + codeLen(i);
    let next = annexb.length;
    for (let j = from; j + 2 < annexb.length; j += 1) {
      if (start(j)) {
        next = j;
        break;
      }
    }
    nals.push(annexb.subarray(from, next));
    i = next;
  }
  return nals;
}

/** The NALs of one type from an access unit: 7 = SPS, 8 = PPS, 5 = IDR slice, 1 = non-IDR slice. */
export function parameterSets(nals, type) {
  return nals.filter((nal) => (nal[0] & 0x1f) === type);
}

/** The ISO/IEC 14496-15 decoder configuration record WebCodecs calls `description`. */
export function buildAvcC(sps, pps) {
  if (sps.length === 0 || pps.length === 0) return undefined;
  const sps0 = sps[0];
  // profile_idc, profile_compat, level are SPS bytes 1..3, and lengthSizeMinusOne is byte 7's low 2 bits.
  const out = [0x01, sps0[1], sps0[2], sps0[3], 0xfc | (sps0.length > 7 ? sps0[7] & 0x03 : 3), 0xe0 | sps.length];
  for (const s of sps) out.push((s.length >> 8) & 255, s.length & 255, ...s);
  out.push(pps.length);
  for (const p of pps) out.push((p.length >> 8) & 255, p.length & 255, ...p);
  return Buffer.from(out);
}

/** Annex-B access unit -> four-byte-length-prefixed AVCC, the form VideoDecoder.decode takes. */
export function toAvcc(nals) {
  let total = 0;
  for (const nal of nals) total += 4 + nal.length;
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const nal of nals) {
    out.writeUInt32BE(nal.length, at);
    nal.copy(out, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

/** The `avc1.ppnnll` codec string a browser decoder is configured with, from the avcC record. */
export function codecString(avcC) {
  return `avc1.${avcC.subarray(1, 4).toString("hex")}`;
}

// ---------------------------------------------------------------- envelope writer
// One envelope frame is one write: a header split from its payload, or two frames interleaved, would
// desynchronise every frame after it. The sink may be a pipe to a daemon or a file, and it may
// backpressure; frames that cannot go out yet wait in an explicit queue whose depth is known.

/**
 * @param write   takes one complete frame (header + tag + payload), returns whether the sink took it
 *                without buffering (false means "wait for drain", same as a Node writable).
 * @param maxQueuedBytes  backlog past which a *delta* is dropped rather than queued. An H.264 P-frame
 *                carries a difference, so skipping from frame N to N+3 decodes as one slightly larger
 *                delta, while an unbounded queue turns a stalled viewer into an out-of-memory kill.
 *                Descriptions and key frames are never dropped — losing one of those loses the stream.
 */
export function createEnvelopeWriter({ write, maxQueuedBytes = 4 * 1024 * 1024 }) {
  const state = { frames: 0, bytes: 0, dropped: 0, queue: [], queued: 0, draining: false, metaWritten: false };

  function drain() {
    if (state.draining) return;
    state.draining = true;
    while (state.queue.length > 0) {
      if (!write(state.queue.shift())) break;
    }
    // why the backlog is re-measured rather than decremented per write: a sink that accepts a buffer
    // keeps it itself, so the only honest number is the sum of what is still ours to send.
    state.queued = state.queue.reduce((sum, frame) => sum + frame.length, 0);
    state.draining = false;
  }

  return {
    state,
    /** Queue one frame and try to push it out; returns after the sink has refused or taken it. */
    emit(tag, payload) {
      if (!state.metaWritten && tag !== TAG.meta) {
        // why fatal rather than tolerant: writing the meta frame first is the one promise the envelope
        // makes, and the daemon refuses a stream that breaks it. Doing it ourselves is how the bug
        // shows up in our log instead of as a mysterious refused stream.
        throw new Error(`internal: envelope tag ${String(tag)} before the meta frame`);
      }
      if (tag === TAG.meta) state.metaWritten = true;
      if (state.queued > maxQueuedBytes && tag === TAG.delta) {
        state.dropped += 1;
        return;
      }
      const frame = Buffer.allocUnsafe(5 + payload.length);
      frame.writeUInt32BE(payload.length + 1, 0);
      frame[4] = tag;
      payload.copy(frame, 5);
      state.frames += 1;
      state.bytes += frame.length;
      state.queue.push(frame);
      state.queued += frame.length;
      drain();
    },
    drain,
  };
}

// ---------------------------------------------------------------- protocol reader
//
// The loop ends by running out of bytes — the caller ends the source when the device hangs up or when
// it is told to stop — because a deadline tested inside the loop would not be seen while awaiting a
// header. `onMeta` is called on the first session packet, before any picture, which is the one order
// the envelope promises.
export async function readScrcpyStream({ source, onMeta, onPacket }) {
  let codecId;
  try {
    codecId = (await source.need(4)).readUInt32BE(0);
  } catch (error) {
    // why re-thrown rather than swallowed: a source that ends before the codec id is a device that hung
    // up without ever streaming, which is the failure the caller must report, not the clean end this
    // reader otherwise signals when it runs out of bytes mid-picture.
    throw error?.end === true ? new Error("the device closed the stream before its codec id") : error;
  }
  if (codecId === 0) throw new Error("the device disabled this stream");
  if (codecId === 1) throw new Error("server configuration error");
  const name = [(codecId >> 24) & 255, (codecId >> 16) & 255, (codecId >> 8) & 255, codecId & 255]
    .map((byte) => String.fromCharCode(byte))
    .join("");
  const codec = { id: codecId, name: name.trim() };

  let width = 0;
  let height = 0;
  let metaSent = false;
  const stats = { sessions: 0, configPackets: 0, keyframes: 0, frames: 0, bytes: 0 };

  // why the error is swallowed by kind: an ended source is this reader finishing its job, whereas a
  // socket error is the capture failing, and reporting the first as the second is how a healthy run
  // gets thrown away.
  let endedCleanly = false;
  try {
    for (;;) {
      // why: discriminate on the first bit before reading anything else. A session packet and a media
      // packet are both 12 bytes but lay those bytes out differently, so reading 12 up front and deciding
      // afterwards is how a parser gets quietly out of step and keeps counting garbage.
      const first = (await source.need(4)).readUInt32BE(0);
      if ((first >>> 31) === 1) {
        width = (await source.need(4)).readUInt32BE(0);
        height = (await source.need(4)).readUInt32BE(0);
        stats.sessions += 1;
        if (!metaSent) {
          metaSent = true;
          onMeta({ width, height, codec });
        }
        continue;
      }
      const tail = await source.need(8);
      const ptsAndFlags = (BigInt(first) << 32n) | BigInt(tail.readUInt32BE(0));
      const size = tail.readUInt32BE(4);
      const isConfig = ((ptsAndFlags >> 62n) & 1n) === 1n;
      const isKey = ((ptsAndFlags >> 61n) & 1n) === 1n;
      const payload = await source.need(size);
      if (!metaSent) {
        throw new Error("a media packet arrived before the session packet, so the geometry is unknown");
      }
      stats.frames += 1;
      stats.bytes += payload.length;
      if (isConfig) stats.configPackets += 1;
      if (isKey) stats.keyframes += 1;
      onPacket({ payload, isConfig, isKey, ptsAndFlags, width, height });
    }
  } catch (error) {
    if (error?.end !== true) throw error;
    endedCleanly = true;
  }
  return { endedCleanly, codec, width, height, stats };
}

/**
 * Turns one scrcpy media packet into the envelope frames it implies, remembering the parameter sets
 * across packets. Returns what it wrote, so the caller can log and count without knowing any of this.
 *
 * scrcpy folds SPS/PPS into its config packet, and some encoders repeat them in the IDR. A key frame is
 * undecodable without its parameter sets, so a description goes out immediately ahead of a key frame
 * when no config packet has produced one yet — a viewer that joins on an IDR must never be left waiting
 * for a description that may not arrive.
 */
export function createAccessUnitEmitter({ emit }) {
  let sps = [];
  let pps = [];
  let descriptionWritten = false;
  let lastCodecString;

  const writeDescription = () => {
    const avcC = buildAvcC(sps, pps);
    if (avcC === undefined) return undefined;
    descriptionWritten = true;
    lastCodecString = codecString(avcC);
    emit(TAG.description, avcC);
    return avcC;
  };

  return {
    /**
     * @param payload one media packet, Annex-B
     * @param isConfig  the packet's config flag
     * @param isKey     the packet's key-frame flag
     */
    mediaPacket(payload, isConfig, isKey) {
      const nals = toNals(payload);
      const freshSps = parameterSets(nals, 7);
      const freshPps = parameterSets(nals, 8);
      if (freshSps.length > 0) sps = freshSps;
      if (freshPps.length > 0) pps = freshPps;

      if (isConfig) {
        const avcC = writeDescription();
        return { kind: "config", written: avcC === undefined ? 0 : 1, reason: avcC === undefined ? "no SPS/PPS" : "" };
      }
      if (isKey && !descriptionWritten && writeDescription() === undefined) {
        // why dropped rather than written: a key frame with no parameter sets anywhere is not decodable
        // by anything downstream, and forwarding it only moves the failure into the viewer.
        return { kind: isKey ? "key" : "delta", written: 0, reason: "key frame with no parameter sets seen yet" };
      }
      emit(isKey ? TAG.keyframe : TAG.delta, toAvcc(nals));
      return { kind: isKey ? "key" : "delta", written: 1, reason: "" };
    },
    get descriptionWritten() {
      return descriptionWritten;
    },
    get codecString() {
      return lastCodecString;
    },
  };
}
