// ─── Voice input pipeline ─────────────────────────────────────────────────────
//
// How one speaker's audio becomes a question for Luna. Each stage is a small
// piece with one job, wired together per speaker by continuousCapture() in
// index.js:
//
//   Opus packets ──► packet decoder ──► PCM (20 ms frames, 48 kHz mono)
//                                         │
//                    ┌────────────────────┴───────────────────┐
//                    ▼                                        ▼
//          wake feeder ──► wake-word model          segmenter (energy gate,
//          (fills silent gaps so the model's        lead-in, silence timer)
//          timeline matches the clock)                        │
//                    │ detection time, peak score             ▼ utterance
//                    └──────────────────────► decideWake: detected / candidate / discard
//                                                             │
//                                                             ▼ (transcribed)
//                                                 confirmWake: the question, or nothing
//
// Plus the decision for a speaker Discord says is talking but whose audio
// never reaches Luna (decideSilentSpeaker).
//
// Everything here is plain logic: no Discord, no network, no environment
// variables. Settings are passed in, and the Opus decoder is handed over by
// the caller, so each stage can be tested on its own.

// ── Wake phrase in a transcript ──────────────────────────────────────────────

// The phrase at the START of a transcript, tolerating Whisper's spellings.
// The trailing \b is load-bearing: without it "lunar eclipse" matches and gets
// mangled into "eclipse".
const WAKE_RE = /^\s*(?:hey|hay|hi)?[\s,.]*(?:luna|loona|runa|roona)\b[\s,.]*/i;
// The same phrase anywhere in a transcript ("so anyway, hey Luna, what's…").
const WAKE_ANYWHERE_RE = /(?:\b(?:hey|hay|hi)[\s,.]*)?\b(?:luna|loona|runa|roona)\b[\s,.!?]*/i;

// Removes a leading wake phrase; a no-op when there is none.
const stripWakeWord = text => text.replace(WAKE_RE, '').trim();

// ── Packet decoder ───────────────────────────────────────────────────────────
//
// Decodes packet by packet and drops only the packets that cannot be decoded.
// (A piped decoder stream is destroyed by its first bad packet, which used to
// deafen Luna to that speaker for good. Bad packets are routine right after
// Luna joins or reconnects, while the encryption session is being set up.)
// onUndecodable(count) reports drops at most every reportEveryMs.
function createPacketDecoder(decoder, { onPcm, onUndecodable = () => {}, reportEveryMs = 10000, now = Date.now }) {
  let undecodable = 0;
  let reportedAt = 0;
  return packet => {
    let pcm;
    try {
      pcm = decoder.decode(packet);
    } catch (_) {
      undecodable++;
      if (now() - reportedAt >= reportEveryMs) {
        onUndecodable(undecodable);
        undecodable = 0;
        reportedAt = now();
      }
      return;
    }
    onPcm(pcm);
  };
}

// ── Wake feeder ──────────────────────────────────────────────────────────────
//
// Discord sends nothing during silence, so without help a pause inside the
// wake phrase would be spliced out of the model's view and the phrase become
// unrecognisable. Before each frame, the gap since the last one (beyond a
// frame's length, capped at maxFillMs) is written as silence.
// feed(frame) resolves to the model's score for that frame (or null).
function createWakeFeeder(wakeStream, { frameMs = 20, maxFillMs = 2000, sampleRate = 48000, now = Date.now }) {
  let lastFrameAt = 0;
  return frame => {
    const at = now();
    if (lastFrameAt) {
      const gapMs = at - lastFrameAt - frameMs;
      if (gapMs > frameMs) {
        const samples = Math.floor((Math.min(gapMs, maxFillMs) / 1000) * sampleRate);
        if (samples > 0) wakeStream.write(Buffer.alloc(samples * 2)).catch(() => {});
      }
    }
    lastFrameAt = at;
    return wakeStream.write(frame);
  };
}

// ── Segmenter ────────────────────────────────────────────────────────────────
//
// Cuts one speaker's frames into utterances with an energy gate:
//   - a frame above energyThreshold starts (or continues) speech and restarts
//     the silence timer; quiet frames while speaking are kept;
//   - quiet frames before speech fill a short lead-in ring (prerollFrames),
//     prepended when speech starts so word onsets aren't clipped;
//   - silenceMs after the last loud frame, onSilence() is called — the owner
//     decides whether to take() the utterance now;
//   - at most maxFrames are kept (the oldest are dropped).
// speechStartedAt marks the energy onset, not the start of the lead-in: the
// wake-word window is calibrated against it.
function createSegmenter({ energyThreshold, prerollFrames, frameMs = 20, maxFrames, silenceMs, onSilence,
                           now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let frames = [];
  let preroll = [];
  let prerollMs = 0;          // how much of the current utterance is lead-in
  let speaking = false;
  let speechStartedAt = 0;
  let silenceTimer = null;

  const loud = frame => {
    let sum = 0;
    for (let i = 0; i < frame.length - 1; i += 2) sum += Math.abs(frame.readInt16LE(i));
    return (sum / (frame.length / 2)) > energyThreshold;
  };
  const stopTimer = () => { if (silenceTimer) clearTimer(silenceTimer); silenceTimer = null; };

  return {
    get speaking() { return speaking; },
    get speechStartedAt() { return speechStartedAt; },
    get buffered() { return frames.length; },

    push(frame) {
      if (loud(frame)) {
        if (!speaking) {
          speechStartedAt = now();
          if (preroll.length) {
            prerollMs = preroll.length * frameMs;
            frames.push(...preroll);
            preroll = [];
          }
        }
        speaking = true;
        frames.push(frame);
        stopTimer();
        silenceTimer = setTimer(() => { silenceTimer = null; onSilence(); }, silenceMs);
      } else if (speaking) {
        frames.push(frame);
      } else if (prerollFrames > 0) {
        preroll.push(frame);
        if (preroll.length > prerollFrames) preroll.shift();
      }
      while (frames.length > maxFrames) frames.shift();
    },

    // The utterance so far, and start a new one. speechMs excludes the lead-in.
    take() {
      const pcm = Buffer.concat(frames);
      frames = [];
      speaking = false;
      const durationMs = (pcm.length / 2 / 48000) * 1000;
      const speechMs = durationMs - prerollMs;
      prerollMs = 0;
      return { pcm, durationMs, speechMs, speechStartedAt };
    },

    // Keep only the last `count` frames (barge-in: the new question, without
    // what was said while waiting).
    keepLast(count) {
      if (frames.length > count) {
        frames = frames.slice(-count);
        prerollMs = 0;
      }
    },

    // Throw away the current utterance (it could not be taken).
    abandon() {
      speaking = false;
      frames = [];
      preroll = [];
      prerollMs = 0;
    },

    stopSilenceTimer: stopTimer,
    close: stopTimer,
  };
}

// ── Wake decision for an utterance ───────────────────────────────────────────
//
//   detected   the model fired inside this utterance: a two-sided window —
//              no earlier than graceMs before speech began (the model fires
//              as the phrase ends, which can precede the energy gate), and
//              not stale relative to the audio being sent. Discord stops
//              sending during silence, so buffered duration can lag the clock;
//              staleness is measured against whichever is longer.
//   candidate  no detection, but the model's peak score reached
//              candidateThreshold: probably "hey Luna" run into the question.
//              Whisper decides (confirmWake).
//   discard    neither.
function decideWake({ wakeAt, speechStartedAt, now, durationMs, peak, graceMs, candidateThreshold }) {
  const span = Math.max(durationMs, now - speechStartedAt);
  const detected = wakeAt > 0 && wakeAt >= speechStartedAt - graceMs && now - wakeAt <= span + graceMs;
  if (detected) return { verdict: 'detected', span };
  if (candidateThreshold > 0 && peak >= candidateThreshold) return { verdict: 'candidate', span };
  return { verdict: 'discard', span };
}

// ── Wake phrase in the transcript → the question ─────────────────────────────
//
//   detected   the model already heard the wake word: the transcript is not
//              re-checked (Whisper often mangles or drops a leading "hey
//              Luna"); a leading wake phrase is removed.
//   candidate  "Luna" must appear somewhere; the question is what follows it.
//   neither    (no wake-word model) the transcript must start with it.
// A bare "hey Luna" stays as the question, so it is answered as a greeting.
function confirmWake(transcript, { detected = false, candidate = false } = {}) {
  if (candidate && !detected) {
    const match = WAKE_ANYWHERE_RE.exec(transcript);
    if (!match) return { accepted: false, reason: 'no "Luna" in the transcript' };
    return { accepted: true, query: transcript.slice(match.index + match[0].length).trim() || transcript };
  }
  if (!detected && !WAKE_RE.test(transcript)) return { accepted: false, reason: 'no wake word' };
  return { accepted: true, query: stripWakeWord(transcript) || transcript };
}

// ── A speaker who seems to be talking but is never heard ─────────────────────
//
// Discord reports them speaking, yet no audio has reached Luna for a while.
// verdict is their encryption state (cryptoVerdict in index.js) or null.
//   restart-capture  their audio is decrypting, so encryption is fine and it
//                    is being lost after that: restart just their capture
//   wait             Luna reconnected recently (at most once per gapMs)
//   reconnect        reconnect the voice session for fresh encryption keys
function decideSilentSpeaker({ verdict, now, lastReconnectAt, gapMs }) {
  if (verdict && !verdict.problem && verdict.ok > 0) return 'restart-capture';
  if (now - lastReconnectAt < gapMs) return 'wait';
  return 'reconnect';
}

module.exports = {
  WAKE_RE, WAKE_ANYWHERE_RE, stripWakeWord,
  createPacketDecoder, createWakeFeeder, createSegmenter,
  decideWake, confirmWake, decideSilentSpeaker,
};
