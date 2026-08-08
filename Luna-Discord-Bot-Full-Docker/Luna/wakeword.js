'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// openWakeWord — JavaScript port of the streaming inference pipeline.
//
// Faithful reimplementation of openwakeword.utils.AudioFeatures._streaming_features
// (https://github.com/dscripka/openWakeWord, Apache-2.0) using onnxruntime-node.
//
// The pipeline is three chained ONNX models:
//
//   16kHz int16 PCM ──► melspectrogram.onnx ──► (frames, 32) mel
//                  ──► embedding_model.onnx ──► (96,) speech embedding
//                  ──► <your>.onnx          ──► sigmoid score in [0, 1]
//
// Timing: audio is consumed in fixed 1280-sample (80 ms) chunks. From the
// second chunk onward each one yields exactly 8 new mel frames and exactly 1
// new embedding, so the detector produces one score every 80 ms (12.5 Hz).
// (The first chunk yields 5 frames, since there is no lookback yet — upstream
// behaves identically.)
//
// Discord delivers 48 kHz PCM, so each stream is decimated 48k -> 16k through an
// anti-aliased FIR before entering the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

let ort = null;
try {
  ort = require('onnxruntime-node');
} catch (_) {
  // Left null — load() reports a clean error and the caller falls back to
  // transcript-based wake word matching.
}

// ─── Pipeline constants (must match openWakeWord exactly) ────────────────────

const SAMPLE_RATE   = 16000;
const CHUNK         = 1280;      // 80 ms — the unit of streaming work
const MEL_CONTEXT   = 480;       // 160*3 — lookback so a chunk yields exactly 8 frames
const MEL_BINS      = 32;        // fixed by melspectrogram model
const EMB_FRAMES    = 76;        // mel frames per embedding window
const EMB_DIM       = 96;        // fixed by embedding model
const MEL_MAX_LEN   = 970;       // 10*97 — mel buffer cap
const FEAT_MAX_LEN  = 120;       // ~10 s of embedding history
const DEFAULT_FRAMES = 16;       // embeddings fed to the classifier

// openWakeWord seeds the mel buffer with ones, not zeros. Keep it identical.
const MEL_INIT_VALUE = 1.0;

// openWakeWord seeds feature_buffer with embeddings of 4 s of random noise so
// the classifier window is full from the very first chunk. Without this the
// first real audio sits at the LEFT edge of the window — the worst possible
// alignment — and the opening wake word of a stream is missed.
const SEED_SECONDS = 4;

// model.py discards the first few predictions of a stream while the seeded
// noise embeddings are still shifting out of the window.
const PREDICTION_WARMUP = 5;

// Max un-processed writes before audio is dropped. Discord delivers 20 ms
// frames, so 25 is ~500 ms of buffered lag — well past the point where a
// detection would still be useful.
const MAX_QUEUE_DEPTH = 25;

// ─── Automatic gain control (detector input only) ────────────────────────────
//
// Models trained on synthetic TTS without volume augmentation are often very
// level-sensitive: the same phrase can score 0.85 spoken loudly and 0.10 at
// normal volume. Mel magnitudes scale directly with amplitude, so quiet speech
// lands in a region of embedding space the classifier never saw.
//
// This normalises the signal toward a target RMS before feature extraction.
// It only ever BOOSTS — gain is clamped to >= 1 — so audio that already works
// passes through untouched and this cannot regress a working setup.
//
// Applies to detection only. The audio sent to Whisper is never modified.
// Target is deliberately well above conversational Discord levels (~1500-2500
// RMS). Synthetic TTS training data is typically normalised loud, so matching
// that distribution means boosting past "normal speech", not toward it.
const AGC_TARGET_RMS   = parseInt(process.env.OWW_AGC_TARGET_RMS || '4000', 10);
const AGC_MAX_GAIN     = 8;
const AGC_NOISE_FLOOR  = 60;     // below this, assume silence and don't amplify hiss
const AGC_SMOOTHING    = 0.1;    // EMA weight; low = slow gain changes, less pumping
const AGC_PEAK_CEILING = 29000;  // clipped audio is worse for the classifier than quiet audio

// ─── 48 kHz -> 16 kHz decimator ──────────────────────────────────────────────
//
// Naive "take every 3rd sample" decimation aliases everything above 8 kHz back
// into the speech band and measurably degrades detection. This applies a
// windowed-sinc low-pass before dropping samples, and carries filter state
// across chunks so there is no discontinuity at chunk boundaries.

function designLowPass(numTaps, normalizedCutoff) {
  const taps = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  let sum = 0;

  for (let n = 0; n < numTaps; n++) {
    const k = n - mid;
    // sinc
    const sinc = k === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * k) / (Math.PI * k);
    // Hamming window
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numTaps - 1));
    taps[n] = sinc * w;
    sum += taps[n];
  }

  // Normalize to unity DC gain so loudness is preserved.
  for (let n = 0; n < numTaps; n++) taps[n] /= sum;
  return taps;
}

class Decimator3 {
  constructor(numTaps = 61) {
    // Cutoff at 7.2 kHz against a 48 kHz rate leaves a transition band below
    // the 8 kHz Nyquist of the decimated signal.
    this.taps  = designLowPass(numTaps, 7200 / 48000);
    this.hist  = new Float32Array(numTaps - 1);
    this.phase = 0; // decimation phase carried across chunks
  }

  reset() {
    this.hist.fill(0);
    this.phase = 0;
  }

  // input: Float32Array of int16-valued samples @48kHz -> Float32Array @16kHz
  process(input) {
    const T = this.taps.length;
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist, 0);
    buf.set(input, this.hist.length);

    const out = [];
    let i = this.phase + (T - 1);
    for (; i < buf.length; i += 3) {
      let acc = 0;
      for (let t = 0; t < T; t++) acc += this.taps[t] * buf[i - t];
      out.push(acc);
    }

    this.phase = i - buf.length;
    this.hist = buf.slice(buf.length - (T - 1));
    return Float32Array.from(out);
  }
}

// ─── Engine: owns the three ONNX sessions, shared across all users ───────────

class WakeWordEngine {
  constructor({ melspec, embedding, model, featureFrames, inputNames, outputNames, modelName }) {
    this.melspec       = melspec;
    this.embedding     = embedding;
    this.model         = model;
    this.featureFrames = featureFrames;
    this.inputNames    = inputNames;
    this.outputNames   = outputNames;
    this.modelName     = modelName;
    this.seedFeatures  = null; // filled by _buildSeed(), shared by every stream

    // A non-finite window size would silently disable detection: it makes the
    // refractory comparison and the buffer trim both NaN.
    if (!Number.isFinite(this.featureFrames) || this.featureFrames < 1) {
      throw new Error(`Invalid featureFrames: ${this.featureFrames}`);
    }
  }

  // Runs SEED_SECONDS of deterministic noise through the real streaming path
  // once, at load time. Every stream then starts from a copy of the resulting
  // embeddings, matching openWakeWord's pre-seeded feature_buffer without
  // paying the cost per user.
  async _buildSeed() {
    const n = SAMPLE_RATE * SEED_SECONDS;
    const buf = Buffer.alloc(n * 2);

    // Deterministic glibc LCG in place of np.random.randint(-1000, 1000), so
    // every process starts from an identical baseline.
    //
    // Math.imul is required, not cosmetic: `s * 1103515245` reaches ~2^61,
    // past the 2^53 exact-integer limit for doubles. The rounding would zero
    // the low bits of the state, collapsing the period and turning the "noise"
    // into a periodic buzz. Math.imul does exact 32-bit multiplication.
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      buf.writeInt16LE(((s % 2000) - 1000), i * 2);
    }

    const warm = new WakeWordStream(this, { inputRate: SAMPLE_RATE, seeded: false });
    await warm.write(buf);

    // write() swallows inference errors to keep the stream alive; here that
    // would silently leave every stream unseeded, so fail loudly instead.
    if (warm.featBuffer.length < this.featureFrames) {
      throw new Error(
        `feature seeding produced ${warm.featBuffer.length} embeddings, ` +
        `need at least ${this.featureFrames} — the ONNX models are likely incompatible`
      );
    }

    this.seedFeatures = warm.featBuffer.map(row => Float32Array.from(row));
    console.log(
      `[oww] seeded feature buffer with ${this.seedFeatures.length} noise embeddings ` +
      `(baseline score ${warm.lastScore.toFixed(4)})`
    );
  }

  static async load({ modelPath, melspecPath, embeddingPath, featureFrames }) {
    if (!ort) {
      throw new Error(
        'onnxruntime-node is not installed. Run `npm install onnxruntime-node`.'
      );
    }

    const FEATURE_MODEL_HINT =
      'melspectrogram.onnx and embedding_model.onnx are shared by every openWakeWord ' +
      'model and can be downloaded from the openWakeWord releases page ' +
      '(https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1).';

    for (const [label, p, hint] of [
      ['wake word model', modelPath,
        'This is the model you trained. Check OWW_MODEL_PATH, or place the file here.'],
      ['melspectrogram model', melspecPath, FEATURE_MODEL_HINT],
      ['embedding model', embeddingPath, FEATURE_MODEL_HINT],
    ]) {
      if (!fs.existsSync(p)) {
        throw new Error(`Missing ${label} at ${p}. ${hint}`);
      }
    }

    // Single-threaded sessions: these models are tiny and we run many streams.
    const opts = { intraOpNumThreads: 1, interOpNumThreads: 1 };

    const [melspec, embedding, model] = await Promise.all([
      ort.InferenceSession.create(melspecPath, opts),
      ort.InferenceSession.create(embeddingPath, opts),
      ort.InferenceSession.create(modelPath, opts),
    ]);

    const inputNames = {
      melspec:   melspec.inputNames[0],
      embedding: embedding.inputNames[0],
      model:     model.inputNames[0],
    };
    const outputNames = {
      melspec:   melspec.outputNames[0],
      embedding: embedding.outputNames[0],
      model:     model.outputNames[0],
    };

    // Prefer the classifier's declared window size over a hardcoded 16.
    let frames = featureFrames || 0;
    if (!frames) {
      try {
        const md = model.inputMetadata;
        const dims = md && md[0] && (md[0].shape || md[0].dims);
        if (Array.isArray(dims) && typeof dims[1] === 'number' && dims[1] > 0) {
          frames = dims[1];
        }
      } catch (_) { /* metadata unavailable on some onnxruntime-node builds */ }
    }
    if (!frames) frames = DEFAULT_FRAMES;

    console.log(
      `[oww] loaded ${path.basename(modelPath)} ` +
      `(input="${inputNames.model}", window=${frames} frames)`
    );

    const engine = new WakeWordEngine({
      melspec, embedding, model,
      featureFrames: frames,
      inputNames, outputNames,
      modelName: path.basename(modelPath, '.onnx'),
    });

    await engine._buildSeed();
    return engine;
  }

  createStream(opts) {
    return new WakeWordStream(this, opts);
  }
}

// ─── Per-user stream state ───────────────────────────────────────────────────

class WakeWordStream {
  constructor(engine, {
    threshold        = 0.5,
    triggerFrames    = 1,     // consecutive frames above threshold to fire
    refractoryMs     = 1500,  // ignore re-fires for this long after a detection
    onDetect         = null,
    label            = '',
    inputRate        = 48000, // 48000 = decimate (Discord); 16000 = passthrough
    seeded           = true,  // internal: false only for the engine's seed pass
    gain             = 'auto', // 'auto' | 'off' | a fixed multiplier
  } = {}) {
    this.engine        = engine;
    this.threshold     = threshold;
    this.triggerFrames = triggerFrames;
    this.onDetect      = onDetect;
    this.label         = label;
    this.inputRate     = inputRate;

    // A single wake word stays inside the classifier window for
    // featureFrames * 80 ms. If the refractory period is shorter than that,
    // one utterance fires twice — and the second fire lands after the
    // utterance was flushed, where it would wrongly validate the next one.
    const windowMs = engine.featureFrames * 80;
    this.refractoryMs = Math.max(refractoryMs, windowMs + 200);

    if (inputRate !== 48000 && inputRate !== 16000) {
      throw new Error(`Unsupported inputRate ${inputRate} (expected 48000 or 16000)`);
    }

    this.decimator = new Decimator3();

    // Raw 16 kHz tail. Only the last CHUNK + MEL_CONTEXT samples are ever read.
    this.raw = new Float32Array(CHUNK + MEL_CONTEXT);
    this.rawFilled = 0;

    this.pending = [];      // 16 kHz samples not yet forming a full 1280 chunk
    this.pendingLen = 0;

    this.melBuffer = [];    // rows of Float32Array(32)
    for (let i = 0; i < EMB_FRAMES; i++) {
      this.melBuffer.push(new Float32Array(MEL_BINS).fill(MEL_INIT_VALUE));
    }

    // Start from the engine's shared noise seed so the classifier window is
    // full immediately and real audio enters at the right edge.
    this.featBuffer = (seeded && engine.seedFeatures)
      ? engine.seedFeatures.map(row => Float32Array.from(row))
      : [];

    this.chunksProcessed = 0;
    this.aboveCount      = 0;
    this.lastDetectAt    = 0;
    this.lastScore       = 0;

    // Backpressure accounting.
    this.queueDepth   = 0;
    this.dropped      = 0;
    this.lastDropWarn = 0;

    // Gain control.
    this.gainMode     = gain;
    this.fixedGain    = typeof gain === 'number' ? gain : parseFloat(gain);
    this.smoothedRms  = 0;
    this.smoothedPeak = 0;
    this.lastGain     = 1;
    this.lastRms      = 0;

    // Highest score since the last read. Answers the question debug-score
    // logging cannot: when nothing is logged, was the model scoring 0.25 and
    // just missing the threshold, or 0.002 and not seeing speech at all?
    //
    // Two independent counters because the per-utterance log and the 30 s
    // health line consume on different schedules — one shared counter would
    // let whichever fired first blank the other's reading.
    this.peakScore  = 0;  // consumed per utterance
    this.healthPeak = 0;  // consumed per health line

    // If a model declares a window larger than the history cap, trimming would
    // starve the classifier forever. Keep at least a full window.
    this.featMaxLen = Math.max(FEAT_MAX_LEN, engine.featureFrames);

    // Serializes async inference so buffer mutations cannot interleave.
    this.queue = Promise.resolve();
    this.closed = false;
  }

  reset() {
    this.decimator.reset();
    this.rawFilled = 0;
    this.raw.fill(0);
    this.pending = [];
    this.pendingLen = 0;
    this.melBuffer = [];
    for (let i = 0; i < EMB_FRAMES; i++) {
      this.melBuffer.push(new Float32Array(MEL_BINS).fill(MEL_INIT_VALUE));
    }
    this.featBuffer = this.engine.seedFeatures
      ? this.engine.seedFeatures.map(row => Float32Array.from(row))
      : [];
    this.chunksProcessed = 0;
    this.aboveCount = 0;
  }

  close() {
    this.closed = true;
  }

  // Read-and-reset, so each caller sees the peak over its own interval.
  takePeak() {
    const p = this.peakScore;
    this.peakScore = 0;
    return p;
  }

  takeHealthPeak() {
    const p = this.healthPeak;
    this.healthPeak = 0;
    return p;
  }

  // Accepts a Buffer of signed 16-bit LE PCM, mono, at `inputRate`
  // (48 kHz for Discord decoder output). Returns a promise resolving to the
  // most recent score, or null if no full chunk was processed.
  // Safe to call without awaiting.
  write(pcm) {
    if (this.closed) return Promise.resolve(null);

    const n = Math.floor(pcm.length / 2);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2);

    // Always run the decimator, even for audio about to be dropped, so its
    // filter state stays continuous.
    const down = this.inputRate === 16000
      ? samples
      : this.decimator.process(samples);

    // Backpressure. Inference is chained on a promise queue; if the CPU cannot
    // keep up, that queue grows without bound and detection falls further
    // behind wall-clock forever — which presents as the detector silently
    // "stopping" after a few minutes. Dropping audio may miss one wake word;
    // falling behind misses every subsequent one.
    if (this.queueDepth >= MAX_QUEUE_DEPTH) {
      this.dropped += down.length;
      const now = Date.now();
      if (now - this.lastDropWarn > 5000) {
        this.lastDropWarn = now;
        console.warn(
          `[oww${this.label ? ' ' + this.label : ''}] OVERLOADED — dropped ` +
          `${(this.dropped / SAMPLE_RATE).toFixed(1)}s of audio in the last 5s. ` +
          'Wake word inference cannot keep up with realtime on this machine.'
        );
        this.dropped = 0;
      }
      return Promise.resolve(null);
    }

    this.queueDepth++;
    this.queue = this.queue
      .then(() => this._consume(down))
      .catch(err => {
        console.error(`[oww${this.label ? ' ' + this.label : ''}] inference error:`, err.message);
        return null;
      })
      .then(score => { this.queueDepth--; return score; });

    return this.queue;
  }

  async _consume(samples16k) {
    if (samples16k.length) {
      this.pending.push(samples16k);
      this.pendingLen += samples16k.length;
    }
    if (this.pendingLen < CHUNK) return null;

    // Flatten pending into one contiguous array.
    let flat = new Float32Array(this.pendingLen);
    let off = 0;
    for (const part of this.pending) { flat.set(part, off); off += part.length; }
    this.pending = [];
    this.pendingLen = 0;

    let result = null;
    let cursor = 0;
    while (flat.length - cursor >= CHUNK) {
      const chunk = flat.subarray(cursor, cursor + CHUNK);
      cursor += CHUNK;
      result = await this._processChunk(chunk);
    }

    // Carry the remainder into the next call.
    if (cursor < flat.length) {
      const rest = flat.slice(cursor);
      this.pending.push(rest);
      this.pendingLen = rest.length;
    }

    return result;
  }

  // Normalises a chunk toward AGC_TARGET_RMS. Never attenuates.
  _applyGain(chunk) {
    if (this.gainMode === 'off') return chunk;

    // Measure level regardless of mode, so the debug log always reports it.
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / chunk.length);

    // Smooth across chunks so gain drifts slowly. An abrupt per-chunk change
    // would create discontinuities inside the 1760-sample mel window, which
    // spans this chunk plus the tail of the previous one.
    this.smoothedRms = this.smoothedRms === 0
      ? rms
      : this.smoothedRms * (1 - AGC_SMOOTHING) + rms * AGC_SMOOTHING;

    // Fast attack, slow release — react instantly to a loud transient, decay
    // gradually, so gain never spikes into clipping on a plosive.
    this.smoothedPeak = Math.max(peak, this.smoothedPeak * 0.95);
    this.lastRms = this.smoothedRms;

    let gain;

    if (Number.isFinite(this.fixedGain) && this.fixedGain > 0) {
      gain = this.fixedGain;
    } else {
      // Silence: leave it alone rather than amplifying room noise into the
      // classifier, which would invite false positives.
      if (this.smoothedRms < AGC_NOISE_FLOOR) {
        this.lastGain = 1;
        return chunk;
      }
      gain = AGC_TARGET_RMS / this.smoothedRms;
    }

    // Cap so peaks stay below the clipping ceiling.
    if (this.smoothedPeak > 0) {
      gain = Math.min(gain, AGC_PEAK_CEILING / this.smoothedPeak);
    }

    gain = Math.min(Math.max(gain, 1), AGC_MAX_GAIN);
    this.lastGain = gain;
    if (gain <= 1.01) return chunk;

    const out = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, chunk[i] * gain));
    }
    return out;
  }

  async _processChunk(rawChunk) {
    const { engine } = this;
    const chunk = this._applyGain(rawChunk);

    // ── 1. Append to the raw tail (keeps last CHUNK + MEL_CONTEXT samples) ──
    if (this.rawFilled === this.raw.length) {
      this.raw.copyWithin(0, CHUNK);
      this.raw.set(chunk, this.raw.length - CHUNK);
    } else {
      const space = this.raw.length - this.rawFilled;
      if (space >= CHUNK) {
        this.raw.set(chunk, this.rawFilled);
        this.rawFilled += CHUNK;
      } else {
        this.raw.copyWithin(0, CHUNK - space);
        this.raw.set(chunk, this.raw.length - CHUNK);
        this.rawFilled = this.raw.length;
      }
    }

    const melInput = this.raw.subarray(0, this.rawFilled);

    // ── 2. Melspectrogram ──────────────────────────────────────────────────
    // Model consumes int16-valued float32 (NOT normalized to [-1,1]).
    const melTensor = new ort.Tensor(
      'float32', Float32Array.from(melInput), [1, melInput.length]
    );
    const melOut = await engine.melspec.run({ [engine.inputNames.melspec]: melTensor });
    const melRaw = melOut[engine.outputNames.melspec];
    const melData = melRaw.data;
    const frames = melData.length / MEL_BINS;

    // openWakeWord's melspec_transform: x/10 + 2
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) {
        row[b] = melData[f * MEL_BINS + b] / 10 + 2;
      }
      this.melBuffer.push(row);
    }
    if (this.melBuffer.length > MEL_MAX_LEN) {
      this.melBuffer = this.melBuffer.slice(-MEL_MAX_LEN);
    }

    // ── 3. Embedding over the trailing 76 mel frames ───────────────────────
    if (this.melBuffer.length < EMB_FRAMES) return null;

    const window = this.melBuffer.slice(-EMB_FRAMES);
    const embInput = new Float32Array(EMB_FRAMES * MEL_BINS);
    for (let f = 0; f < EMB_FRAMES; f++) embInput.set(window[f], f * MEL_BINS);

    const embTensor = new ort.Tensor('float32', embInput, [1, EMB_FRAMES, MEL_BINS, 1]);
    const embOut = await engine.embedding.run({ [engine.inputNames.embedding]: embTensor });
    const embData = embOut[engine.outputNames.embedding].data;

    const emb = new Float32Array(EMB_DIM);
    for (let i = 0; i < EMB_DIM; i++) emb[i] = embData[i];
    this.featBuffer.push(emb);
    this.chunksProcessed++;
    if (this.featBuffer.length > this.featMaxLen) {
      this.featBuffer = this.featBuffer.slice(-this.featMaxLen);
    }

    // ── 4. Classifier ──────────────────────────────────────────────────────
    const need = engine.featureFrames;
    if (this.featBuffer.length < need) return null;

    // Discard the opening predictions while seeded noise is still shifting out
    // of the window (mirrors model.py). Detection is suppressed, but the score
    // is still returned so score-logging stays continuous.
    const warming = this.chunksProcessed <= PREDICTION_WARMUP;

    const feats = this.featBuffer.slice(-need);
    const clsInput = new Float32Array(need * EMB_DIM);
    for (let f = 0; f < need; f++) clsInput.set(feats[f], f * EMB_DIM);

    const clsTensor = new ort.Tensor('float32', clsInput, [1, need, EMB_DIM]);
    const clsOut = await engine.model.run({ [engine.inputNames.model]: clsTensor });
    const score = clsOut[engine.outputNames.model].data[0];
    this.lastScore = score;
    if (score > this.peakScore)  this.peakScore  = score;
    if (score > this.healthPeak) this.healthPeak = score;

    // ── 5. Threshold, debounce, refractory ─────────────────────────────────
    if (warming) {
      this.aboveCount = 0;
      return score;
    }

    if (score >= this.threshold) {
      this.aboveCount++;
      const now = Date.now();
      if (
        this.aboveCount >= this.triggerFrames &&
        now - this.lastDetectAt > this.refractoryMs
      ) {
        this.lastDetectAt = now;
        this.aboveCount = 0;
        if (this.onDetect) {
          try { this.onDetect(score, now); } catch (_) {}
        }
      }
    } else {
      this.aboveCount = 0;
    }

    return score;
  }
}

module.exports = {
  WakeWordEngine,
  WakeWordStream,
  Decimator3,
  designLowPass,
  CHUNK,
  SAMPLE_RATE,
  EMB_DIM,
  EMB_FRAMES,
  MEL_BINS,
};
