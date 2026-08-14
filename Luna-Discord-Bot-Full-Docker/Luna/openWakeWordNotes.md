

Openwakeword · MD
# openWakeWord integration
 
Wake word detection now runs on the raw audio stream instead of on Whisper transcripts.
It acts as a **gate**: only utterances containing a detection are sent to Whisper.
 
```
Discord 48kHz ─► decimate to 16kHz ─► melspectrogram.onnx ─► embedding_model.onnx ─► luna.onnx ─► score
                                                                                                   │
                                              utterance ──────────────────────────────────────► gate ──► Whisper ──► LLM
```
 
If the models fail to load, Luna falls back to the original behaviour (transcribe
everything, then substring-match `WAKE_WORDS`). Nothing breaks; it just costs more CPU.
 
---
 
## Required setup
 
### 1. Download the two shared feature models
 
Your `luna.onnx` is only the final classifier stage. It takes a window of 96-dim speech
embeddings, not audio. The two models that produce those embeddings are identical for
every openWakeWord model and must sit next to it:
 
```bash
cd Luna-Discord-Bot-Full-Docker/Luna
 
curl -LO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx
curl -LO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx
```
 
You should end up with `luna.onnx`, `melspectrogram.onnx`, `embedding_model.onnx`.
 
### 2. Regenerate the lockfile
 
`package.json` gained `onnxruntime-node`, but `package-lock.json` has not been updated —
and the Dockerfile uses `npm ci`, which **fails** on a mismatched lockfile.
 
```bash
npm install
```
 
### 3. Validate offline before running the bot
 
Set `OWW_DEBUG_SCORE=0.05` in `.env`, start the bot, and watch the logs while you speak:
 
```
[oww] score=0.646 gain=1.7x rms=2108
```
 
You should see the score spike well above baseline where you say the wake phrase. Use the
peak to pick a threshold. If scores stay flat, the models are mismatched — stop here,
because the bot will silently never trigger.
 
### 4. Build
 
```bash
cd ..
docker compose up --build
```
 
---
 
## Configuration
 
All optional; defaults are sensible.
 
| Variable | Default | Purpose |
|---|---|---|
| `OWW_ENABLED` | `true` | Set `false` to force transcript matching |
| `OWW_MODEL_PATH` | `./hey_luna.onnx` | Your trained classifier |
| `OWW_MELSPEC_PATH` | `./melspectrogram.onnx` | Shared feature model |
| `OWW_EMBEDDING_PATH` | `./embedding_model.onnx` | Shared feature model |
| `OWW_THRESHOLD` | `0.5` | Raise if false triggers, lower if misses |
| `OWW_TRIGGER_FRAMES` | `1` | Consecutive frames above threshold required |
| `OWW_REFRACTORY_MS` | `1500` | Ignore re-fires after a detection (floored to the classifier window) |
| `OWW_GRACE_MS` | `2000` | How far before an utterance a detection may land and still count |
| `OWW_DEBUG_SCORE` | `0` | Log every score at or above this. Set `0.05` to tune |
| `OWW_GAIN` | `auto` | `auto`, `off`, or a fixed multiplier like `3` |
| `OWW_AGC_TARGET_RMS` | `4000` | Level AGC normalises toward, int16 scale |
| `OWW_FEATURE_FRAMES` | auto | Override the classifier window size |
 
### "I have to speak loudly for it to trigger"
 
Models trained on synthetic TTS without volume augmentation are often very level-sensitive.
A real example from this project: the same speaker and phrase scored **0.867 spoken loudly
and 0.103 at normal volume** — an 8x swing on amplitude alone. Mel magnitudes scale
directly with amplitude, so quiet speech lands in a region of embedding space the
classifier never saw during training. No threshold setting bridges that reliably.
 
`OWW_GAIN=auto` (the default) normalises the detector's input toward a target RMS before
feature extraction. It only ever boosts — gain is clamped to ≥ 1 — so audio that already
scores well is untouched and this cannot regress a working setup. It also refuses to
amplify below a noise floor, so room hiss isn't pushed into the classifier.
 
With `OWW_DEBUG_SCORE` on, the level and applied gain are logged alongside each score:
 
```
[oww] score=0.412 gain=2.1x rms=1870
```
 
Use `rms` to set `OWW_AGC_TARGET_RMS`. Conversational Discord speech measures roughly
1500–2500. The default target of 4000 is deliberately above that: synthetic TTS training
data is normalised loud, so the goal is to boost *past* normal speech, not toward it. If
`gain` reads `1.0x` while you are speaking, the target is at or below your natural level
and AGC is doing nothing — raise it.
 
Gain is also capped so peaks stay under a clipping ceiling, because clipped audio scores
worse than quiet audio. A `gain` that stops rising as you raise the target means you have
hit that cap, and more gain is not available.
 
This affects **detection only**. The audio sent to Whisper is never modified.
 
Also check Discord itself, client-side:
 
- **Noise Suppression (Krisp)** — aggressively reshapes speech and can hurt wake word
  models. Try turning it off.
- **Automatic Gain Control** — makes your level vary unpredictably between utterances.
- **Input Sensitivity** — on automatic, quiet speech may be gated out before it ever
  leaves your machine, and nothing server-side can recover it. Switch to manual.
If normal-volume speech still peaks below ~0.25 with gain applied, that's the model.
Retrain with more samples and volume augmentation.
 
### Audio gate (separate from the wake word)
 
These are also env vars, so they tune with a recreate rather than a rebuild:
 
| Variable | Default | Purpose |
|---|---|---|
| `ENERGY_THRESHOLD` | `300` | Minimum audio energy to buffer for Whisper |
| `SILENCE_MS` | `1000` | Trailing silence before an utterance is flushed |
| `MIN_SPEECH_MS` | `300` | Shortest utterance worth transcribing |
| `MAX_SPEECH_MS` | `15000` | Force-flush after this much unbroken speech |
 
**Setting `ENERGY_THRESHOLD` too low is worse than setting it too high.** An utterance ends
after `SILENCE_MS` of audio *below* this threshold. If it sits under your room's noise
floor, `hasEnergy()` is true on every frame, the silence timer resets on every frame, and
the utterance never ends — that speaker buffers audio indefinitely and is never heard from
again. The health line shows this clearly: `buffered` climbing into the hundreds while
`flushing` stays `false`.
 
`MAX_SPEECH_MS` is the backstop and logs a warning when it fires. If you see that warning,
raise `ENERGY_THRESHOLD` rather than raising `MAX_SPEECH_MS`.
 
The most common cause is Luna hearing herself: her voice plays through your speakers, back
into your mic, and the loop never closes. **Headphones fix this outright.** Discord's echo
cancellation helps but is not reliable at volume.
 
`ENERGY_THRESHOLD` is **independent of wake word detection** — the detector always receives
every frame regardless. But if the model fires and this gate stays shut, there is no
utterance to transcribe, which feels identical to a missed wake word. Lower it to 150–200
for quiet speakers or distant mics.
 
### Tuning
 
Set `OWW_DEBUG_SCORE=0.05` and watch the logs while speaking normally. First, work out
which of the two gates you are hitting:
 
| Symptom in logs | Cause | Fix |
|---|---|---|
| Peak scores stay below threshold | Detection | Lower `OWW_THRESHOLD` |
| `wake word detected` but no `Processing …ms utterance` | Energy gate | Lower `ENERGY_THRESHOLD` |
| `Processing …ms` but no `Query:` | Whisper heard nothing | Lower `ENERGY_THRESHOLD`, raise `SILENCE_MS` |
 
**Have room to lower the threshold.** Compare your wake word peaks against the seeded
baseline printed at startup. A baseline near 0.001 means there is a ~500x gap to the
default 0.5 threshold, so dropping to 0.3 or even 0.25 costs very little in false accepts.
Raise it again only if you actually start seeing spurious triggers.
 
Other symptoms:
 
- **False triggers** → raise `OWW_THRESHOLD`, or set `OWW_TRIGGER_FRAMES=2`
- **Query gets cut off mid-sentence** → raise `SILENCE_MS`
- **Detected, but nothing reaches the LLM** → raise `OWW_GRACE_MS`
### Is it the pipeline or the model?
 
If scores never rise, swap in an official model that is known to be well-trained. It uses
the identical architecture, so it exercises this exact pipeline — same resampler, same
feature models, same audio path:
 
```bash
curl -LO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx
# then set OWW_MODEL_PATH=/app/hey_jarvis_v0.1.onnx and rebuild
```
 
Say "hey jarvis". A healthy model produces a sharp, unmistakable curve:
 
```
score=0.000  ...  score=0.018  score=0.291  score=0.742  score=0.989  score=0.465  score=0.000
```
 
If the control model spikes and yours does not, the pipeline is fine and your model needs
retraining. **No threshold will rescue a model whose peak is ~0.01** — that is the noise
floor, not weak detection. Lowering the threshold that far makes it fire on everything.
 
---
 
## Training a "hey luna" model
 
The wake phrase is `hey luna`, not `luna`. A single-word "luna" is two syllables of common
phonemes with no distinctive onset — it collides with ordinary speech and trains poorly.
Every official openWakeWord model is 3–4 syllables (`hey_jarvis`, `hey_mycroft`, `alexa`)
for this reason.
 
Train with the official [Google Colab notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing)
(~1 hour, no local setup, no manual recording — training data is fully synthetic TTS).
For better quality, use [`automatic_model_training.ipynb`](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb),
which exposes far more control.
 
Guidance from the upstream docs:
 
- Target phrase: `hey luna`
- Several thousand positive examples minimum; quality improves smoothly with more
- Export **ONNX**, not tflite
- Drop the result in `Luna/` and point `OWW_MODEL_PATH` at it (or name it `luna.onnx`)
Rebuild, then check the scores with `OWW_DEBUG_SCORE=0.05`. A good model peaks above 0.9 on
the wake phrase and sits near 0.000 otherwise — see the control curve above.
 
### ⚠️ Licensing — matters for commercial use
 
The openWakeWord **code** is Apache-2.0, and so are the two feature models
(`melspectrogram.onnx` is an ONNX port of Torch's melspectrogram; `embedding_model.onnx`
is Google's `speech_embedding`). Those are fine to ship.
 
The **pre-trained wake word models** — `hey_jarvis`, `alexa`, `hey_mycroft`, etc. — are
licensed **CC BY-NC-SA 4.0 (non-commercial)**, because their training data includes
datasets with restrictive licensing. Use `hey_jarvis_v0.1.onnx` as a *diagnostic only*.
Do not ship it in a customer-facing deployment.
 
A model you train yourself from synthetic TTS data carries no such restriction.
 
---
 
## Implementation notes
 
**Base image changed from `node:20-alpine` to `node:22-slim`.** Two separate reasons.
Debian instead of Alpine because `onnxruntime-node` ships prebuilt binaries linked against
glibc and publishes no musl build, so it cannot load on Alpine at all — a hard requirement,
not a preference. Node 22 instead of 20 because `@discordjs/voice@0.19.2` declares
`engines.node >=22.12.0`; on Node 20 npm only warns and installs anyway, leaving the voice
stack on an unsupported runtime. Note `onnxruntime-node` is large (~270 MB unpacked), so
the image grows accordingly.
 
**Per-speaker state.** Each user gets an independent feature pipeline. Sharing one buffer
across speakers would interleave their audio and corrupt every detection. The three ONNX
sessions are shared; only the ring buffers are per user.
 
**Feature buffer seeding.** openWakeWord pre-seeds its feature buffer with embeddings of
random noise so the classifier window is full from the first chunk. Without this, the
first real audio sits at the *left* edge of the window — the worst alignment — and the
opening wake word of every stream is missed. Because Discord closes an idle audio stream
after 60 s, that would have meant missing the first "Luna" after every pause. The seed is
computed once at startup and copied into each new stream.
 
**Resampling.** Discord delivers 48 kHz; the models require 16 kHz. Naive 3:1 decimation
aliases everything above 8 kHz into the speech band, so a 61-tap windowed-sinc low-pass
runs first, with filter state carried across chunk boundaries.
 
**Transcript check is skipped after a detection.** Whisper frequently mangles or drops a
leading wake word. Re-checking the transcript after the model already confirmed the wake
word on the audio would discard valid queries.
 
---
 
## The flaky-detection trap: packet gaps
 
Symptom: the same phrase from the same speaker scores either ~0.85 or ~0.001, with nothing
in between. Bimodal like that is never a threshold problem — no threshold sits in a gap
that wide, and lowering it just invites false triggers.
 
Cause: Discord only transmits Opus while you are speaking. A pause between "hey" and
"Luna" is not transmitted, so two packets seconds apart in wall-clock time arrive adjacent
in the sample stream. The detector receives a compressed "heyLuna" with the pause spliced
out, matching nothing it was trained on. Say the phrase as one continuous run and the
packets are contiguous and it scores fine — which is why it feels random.
 
Fix: silence is reconstructed from packet arrival timestamps before the audio reaches the
detector (`MAX_SILENCE_FILL_MS`, default 2000). The feature timeline then reflects how the
phrase was actually spoken rather than how Discord chose to transmit it.
 
Diagnosing this class of problem generally: the `peak score` on each discarded utterance is
the fastest signal. Peaks clustered just under the threshold mean tuning will help; peaks at
0.00x mean the model never saw a recognisable phrase and tuning will not.
 
---
 
## Known limitations
 
- Detection lags audio by up to ~160 ms (80 ms accumulation granularity plus inference).
- Discord stops sending Opus packets during true silence, so a classifier window can
  splice across a gap. Inherent to the transport.
- Scores will not match the Python reference *exactly*, because Discord delivers 48 kHz and
  this resamples to 16 kHz with its own filter. Behaviour is equivalent; the last decimal
  place is not.
---
 
## Files
 
| File | Change |
|---|---|
| `wakeword.js` | New. The openWakeWord port. |
| `index.js` | Detector wired in as a pre-Whisper gate. |
| `package.json` | Added `onnxruntime-node`. |
| `Dockerfile` | Alpine → Debian slim (glibc requirement). |
 

