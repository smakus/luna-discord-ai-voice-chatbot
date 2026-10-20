// ─── Listening ────────────────────────────────────────────────────────────────
//
// Hearing people in the voice channel: one capture per speaker, from Discord's
// packets to utterances that passed the wake word (see voice-input.js for the
// stages), handed to onUtterance to transcribe and answer.
//
// When a wake-word model is loaded (openWakeWord), detection runs on the raw
// audio stream and acts as a gate: only utterances containing a detection are
// sent to Whisper. This is both cheaper (Whisper no longer transcribes every
// utterance in the channel) and more accurate than substring-matching a
// transcript. If the model fails to load for any reason, Luna falls back to
// the original behaviour — transcribe everything, then match WAKE_RE against
// the text.
//
// createListener(deps) → listener.
//   voice, OpusEncoder, WakeWordEngine, timers   libraries and setInterval/clearInterval,
//                    passed in so the test harness can fake them
//   session          voice-session.js (speaking/audio notes, encryption state)
//   playback         voice-playback.js (barge-in)
//   botId()          Luna's own user id, never listened to
//   isIgnored(id)    IGNORED_USER_IDS
//   onUtterance(pcm, userId, connection, channel, wakeDetected, wakeCandidate) → Promise
//   onStuck(userId)  a request never returned and the speaker was released

const path = require('path');
const { createPacketDecoder, createWakeFeeder, createSegmenter, decideWake, decideUtteranceEnd } = require('./voice-input');

function createListener({ config, console, voice, OpusEncoder, WakeWordEngine, timers, session, playback, botId, isIgnored, onUtterance, onStuck }) {
  const { EndBehaviorType } = voice;
  const listeningUsers = new Set();

  // ─── Settings ───────────────────────────────────────────────────────────────

  const OWW_ENABLED   = config.OWW_ENABLED;
  const OWW_MODEL     = config.OWW_MODEL_PATH     || path.join(__dirname, 'hey_luna.onnx');
  const OWW_MELSPEC   = config.OWW_MELSPEC_PATH   || path.join(__dirname, 'melspectrogram.onnx');
  const OWW_EMBEDDING = config.OWW_EMBEDDING_PATH || path.join(__dirname, 'embedding_model.onnx');
  const OWW_THRESHOLD = config.OWW_THRESHOLD;
  const OWW_TRIGGER_FRAMES = config.OWW_TRIGGER_FRAMES;
  const OWW_REFRACTORY_MS  = config.OWW_REFRACTORY_MS;
  const OWW_FEATURE_FRAMES = config.OWW_FEATURE_FRAMES;
  // How far before an utterance's first speech a detection may land and still
  // count for that utterance. Covers the gap between the wake word finishing and
  // the energy gate opening.
  const OWW_GRACE_MS = config.OWW_GRACE_MS;
  // Two-stage detection. The model is trained on "hey Luna" said on its own and
  // scores it far lower when the question follows without a pause: in testing
  // with 16 voices, run-on "hey Luna what's the weather" reached the threshold
  // for only 5 (typical peak 0.41 vs 0.66 with a pause), yet 15 of 16 still
  // peaked above 0.1 — while ordinary chat, "lunar" and "tuna" included, peaks
  // around 0.001. So an utterance whose peak is at least this high but that
  // never triggered is a candidate: it is transcribed, and kept only if Whisper
  // heard "Luna" in it. 0 disables (only full detections count).
  const OWW_CANDIDATE_THRESHOLD = config.OWW_CANDIDATE_THRESHOLD;
  // After a bare "hey Luna" and a pause, how long to wait for the question
  // before answering the greeting (decideUtteranceEnd in voice-input.js). She
  // waits silently: the chime always means "got it", once the question is in.
  // 0 disables (the utterance ends after SILENCE_MS, as before).
  const WAKE_LISTEN_MS = config.WAKE_LISTEN_MS;

  // Log every score above this value — useful for tuning OWW_THRESHOLD.
  const OWW_DEBUG_SCORE = config.OWW_DEBUG_SCORE;
  // 'auto' normalises quiet speech up toward a target level before detection,
  // 'off' disables it, or give a fixed multiplier like '3'. Detection input only —
  // the audio sent to Whisper is untouched. Never attenuates, so it cannot make a
  // already-working setup worse.
  const OWW_GAIN = config.OWW_GAIN;

  let wakeEngine = null; // set by initWakeWord(); null means fall back to transcript matching

  // ENERGY_THRESHOLD gates which audio is buffered for Whisper. It is INDEPENDENT
  // of wake word detection — the detector always receives every frame. If the
  // model fires but this gate stays shut, the detection is real but there is no
  // utterance to transcribe, which feels exactly like a missed wake word.
  // Lower it (150-200) for quiet speakers or distant mics.
  const SILENCE_MS       = config.SILENCE_MS;
  const ENERGY_THRESHOLD = config.ENERGY_THRESHOLD;
  const MIN_SPEECH_MS    = config.MIN_SPEECH_MS;

  // Audio kept from BEFORE the energy gate opens, and prepended to the utterance.
  //
  // Without this, everything below ENERGY_THRESHOLD is discarded, so an utterance
  // begins on the first frame loud enough to trip the gate. Low-energy onsets —
  // unvoiced fricatives and stops ("s", "f", "th", "wh", "h", "k", "p", "t") —
  // sit below the threshold for 50-150 ms, so the utterance reaching Whisper
  // starts mid-word. Whisper then guesses the missing onset: "what's the score"
  // arrives as "the score", "set a timer" as "a timer".
  //
  // The detector is unaffected (it always saw every frame); this only changes
  // what is transcribed. Cost is PREROLL_MS of ring buffer per speaker — 320 ms
  // is ~30 KB.
  const PREROLL_MS     = config.PREROLL_MS;
  const PREROLL_CHUNKS = Math.max(0, Math.round(PREROLL_MS / 20));

  // Backstop if something still wedges despite Whisper's and the LLM's own
  // timeouts. Must exceed the longest legitimate request, or it would release a
  // speaker mid-answer.
  const STUCK_FLUSH_MS = config.WHISPER_TIMEOUT_MS + config.LM_TIMEOUT_MS + 60000;

  // Hard cap on a single buffered utterance. `flushing` stays true for the whole
  // LLM + TTS response, during which flushUtterance() early-returns while the
  // decoder keeps appending — without this cap, the segmenter's buffer grows for the entire
  // duration of Luna's reply (~2.9 MB per 30 s per speaker).
  const MAX_UTTERANCE_MS    = 30000;
  const DECODER_CHUNK_MS    = 20; // 960 samples @ 48 kHz
  const MAX_UTTERANCE_CHUNKS = MAX_UTTERANCE_MS / DECODER_CHUNK_MS;

  // Longest a single stretch of speech may run without a silence gap before it is
  // flushed anyway.
  //
  // An utterance normally ends after SILENCE_MS of audio below ENERGY_THRESHOLD.
  // If the threshold sits below the room's noise floor — or Luna's own voice
  // returns through a speaker into the mic — the energy gate is open on every frame,
  // the silence timer is reset on every frame, and the utterance never ends. That
  // speaker then buffers audio forever and is never heard again.
  const MAX_SPEECH_MS = config.MAX_SPEECH_MS;

  // Discord stops transmitting Opus during silence, so two consecutive packets
  // can be seconds apart in wall-clock time while being adjacent in the sample
  // stream. The detector then sees the gap spliced out — "hey ... Luna" spoken
  // with a natural pause arrives as a compressed "heyLuna" that matches nothing
  // the model was trained on. Re-inserting real silence keeps the feature
  // timeline aligned with how the phrase was actually spoken.
  //
  // Capped because the classifier window is only 1.28 s; beyond that the window
  // is fully flushed anyway and further silence is wasted inference.
  const MAX_SILENCE_FILL_MS = config.MAX_SILENCE_FILL_MS;

  // ─── Wake-word model ────────────────────────────────────────────────────────

  async function initWakeWord() {
    if (!OWW_ENABLED) {
      console.log('[oww] disabled via OWW_ENABLED=false — using transcript wake word matching');
      return;
    }
    try {
      wakeEngine = await WakeWordEngine.load({
        modelPath:     OWW_MODEL,
        melspecPath:   OWW_MELSPEC,
        embeddingPath: OWW_EMBEDDING,
        featureFrames: OWW_FEATURE_FRAMES || undefined,
      });
      console.log(`[oww] active — threshold=${OWW_THRESHOLD}, Whisper gated on detection` +
        (OWW_CANDIDATE_THRESHOLD > 0 && OWW_CANDIDATE_THRESHOLD < OWW_THRESHOLD
          ? `; candidates from ${OWW_CANDIDATE_THRESHOLD} confirmed by Whisper` : ''));
    } catch (err) {
      console.warn(`[oww] unavailable (${err.message})`);
      console.warn('[oww] falling back to transcript wake word matching');
      wakeEngine = null;
    }
  }

  // ─── Captures ───────────────────────────────────────────────────────────────

  function listenOn(connection, channel) {
    // Self-heal input (see voice-session.js); separate from the capture start below,
    // which returns early for speakers that already have a capture.
    connection.receiver.speaking.on('start', userId => {
      if (userId === botId() || isIgnored(userId)) return;
      session.noteSpeaking(userId);
    });

    connection.receiver.speaking.on('start', userId => {
      if (listeningUsers.has(userId))   return;
      if (userId === botId())    return; // ignore bot's own audio
      if (isIgnored(userId))    return; // ignore configured bots/users
      listeningUsers.add(userId);
      continuousCapture(connection, userId, channel);
    });
  }

  // Live view of every active capture, for the health heartbeat below.
  const captureStates = new Map();

  // Learned audio level per speaker, keyed by user ID. Survives capture restarts,
  // which happen on every 60 s idle gap — without this, AGC re-learns each
  // speaker's level from scratch while they are saying the wake phrase.
  // A few floats per user; never cleared.
  const userGainState = new Map();

  function continuousCapture(connection, userId, channel) {
    console.log(`[${userId}] capture started`);
    const audioStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 60000 },
    });

    // The pipeline (see voice-input.js): packets → decoder → PCM frames, which
    // go both to the wake-word model and to the segmenter; each utterance the
    // segmenter cuts is gated on the wake word (flushUtterance) and, if it
    // passes, transcribed and turned into a question (onUtterance).
    let flushing       = false;   // an utterance of this speaker is being processed
    let flushStartedAt = 0;
    let lastDataTime   = Date.now();
    let lastWakeAt     = 0;       // when the model last fired, until an utterance consumes it
    let listening      = false;   // waiting for the question after a bare "hey Luna"
    let listenTimer    = null;    // ends that wait if no question comes
    let followUpUntil  = 0;       // after "did you mean to ask me something?": answer without the wake word until then

    const segmenter = createSegmenter({
      energyThreshold: ENERGY_THRESHOLD,
      prerollFrames:   PREROLL_CHUNKS,
      frameMs:         DECODER_CHUNK_MS,
      maxFrames:       MAX_UTTERANCE_CHUNKS,
      silenceMs:       SILENCE_MS,
      onSilence:       () => flushUtterance(),
    });

    // Each speaker needs an independent wake-word pipeline — sharing one buffer
    // across users would interleave their audio and corrupt every detection.
    const wakeStream = wakeEngine
      ? wakeEngine.createStream({
          threshold:     OWW_THRESHOLD,
          triggerFrames: OWW_TRIGGER_FRAMES,
          refractoryMs:  OWW_REFRACTORY_MS,
          gain:          OWW_GAIN,
          gainState:     userGainState.get(userId) || null,
          label:         userId,
          onDetect: (score, at) => {
            lastWakeAt = at;
            console.log(`[${userId}] [oww] wake word detected (score=${score.toFixed(3)})`);

            // Barge-in while this speaker's previous question is still with the
            // LLM. Before, `flushing` held the new request back until the old
            // one finished: during a long think the speaker could not get
            // through at all, and by the time the old answer arrived their
            // buffered "hey Luna" was too old and got discarded. Now the old
            // question is cancelled at once, which releases `flushing` in a
            // moment, and the buffer is cut down to the audio around the wake
            // phrase so the new question is not prefixed by whatever was said
            // during the wait.
            if (flushing) {
              console.log(`[${userId}] barge-in — cancelling the previous question`);
              playback.interrupt(userId);
              segmenter.keepLast(Math.ceil((PREROLL_MS + 1500) / DECODER_CHUNK_MS));
            }
          },
        })
      : null;
    const feedWake = wakeStream
      ? createWakeFeeder(wakeStream, { frameMs: DECODER_CHUNK_MS, maxFillMs: MAX_SILENCE_FILL_MS })
      : null;

    const decodePacket = createPacketDecoder(new OpusEncoder(48000, 1), {
      onPcm,
      onUndecodable: count => console.warn(`[${userId}] ${count} audio packet(s) could not be decoded — dropped ` +
        '(normal for a moment while the encryption session is set up)'),
    });
    audioStream.setMaxListeners(20);
    audioStream.on('data', decodePacket);

    captureStates.set(userId, {
      wakeStream,
      expectQuestion(ms) { followUpUntil = Date.now() + ms; },
      get flushing() { return flushing; },
      get buffered() { return segmenter.buffered; },
      get lastData() { return lastDataTime; },
    });

    function onPcm(frame) {
      lastDataTime = Date.now();
      session.noteAudio(userId);
      // The model hears every frame, quiet ones included.
      if (feedWake) {
        feedWake(frame).then(score => {
          if (OWW_DEBUG_SCORE > 0 && score !== null && score >= OWW_DEBUG_SCORE) {
            console.log(
              `[${userId}] [oww] score=${score.toFixed(3)} ` +
              `gain=${wakeStream.lastGain.toFixed(1)}x rms=${Math.round(wakeStream.lastRms)}`
            );
          }
        }).catch(() => {});
      }
      segmenter.push(frame);
    }

    let blockedWarnAt = 0;

    function flushUtterance() {
      // Being blocked here is how "she only answers once" manifests: `flushing`
      // stays true while a response is in flight, and every utterance in that
      // window is refused. Normally it clears; if it does not, this is the only
      // visible symptom. Rate-limited so it does not flood at 10 Hz.
      if (flushing) {
        const now = Date.now();
        if (now - blockedWarnAt > 10000) {
          blockedWarnAt = now;
          console.warn(
            `[${userId}] flush blocked — still processing a previous request ` +
            `(${Math.round((now - flushStartedAt) / 1000)}s). Speech is buffering, not lost.`
          );
        }
        return;
      }

      if (segmenter.buffered === 0) return;

      // Only the wake phrase so far, then a pause: wait for the question rather
      // than answering "hey Luna" on its own. The question, once spoken, ends
      // the utterance as usual (silence after it); if none comes, the timer
      // ends the wait and the greeting is answered. The timer stands down once
      // the question has begun: firing mid-question cut it off ("…will be like
      // on." — "Saturday" then arrived as an utterance with no wake word).
      const quietMs = Date.now() - segmenter.lastSpeechAt;
      if (wakeStream && decideUtteranceEnd({ quietMs, lastSpeechAt: segmenter.lastSpeechAt,
          wakeAt: lastWakeAt, listenMs: WAKE_LISTEN_MS }) === 'listen') {
        if (!listening) {
          listening = true;
          console.log(`[${userId}] heard "hey Luna" — listening for the question (up to ${WAKE_LISTEN_MS / 1000}s)`);
        }
        clearTimeout(listenTimer);
        listenTimer = setTimeout(() => {
          if (Date.now() - segmenter.lastSpeechAt >= SILENCE_MS) flushUtterance();
        }, WAKE_LISTEN_MS - quietMs + 20);
        return;
      }
      listening = false;
      clearTimeout(listenTimer);

      flushing = true;
      flushStartedAt = Date.now();
      const { pcm, durationMs, speechMs, speechStartedAt } = segmenter.take();

      // Consume the detection up front. Every exit path below must leave
      // lastWakeAt disarmed, otherwise a detection that was dropped by an early
      // return stays armed and silently validates a later, wake-word-free
      // utterance.
      const wakeAt = lastWakeAt;
      lastWakeAt = 0;

      // MIN_SPEECH_MS is measured against speech, not speech plus lead-in, or
      // the lead-in would quietly lower it and let short noise bursts through.
      if (speechMs < MIN_SPEECH_MS) {
        // Too short to transcribe, but the detector sees all audio while the
        // segmenter only keeps frames above ENERGY_THRESHOLD. A quiet speaker
        // can trip the model without clearing the energy gate — re-arm rather
        // than burning the detection and rejecting the query that follows.
        lastWakeAt = wakeAt;
        flushing = false;
        return;
      }

      // The answer to "did you mean to ask me something?": no wake word needed.
      const followUp = Date.now() < followUpUntil;
      followUpUntil = 0;
      if (followUp) {
        wakeStream?.takePeak();
        console.log(`[${userId}] the question after "did you mean to ask me something?" — no wake word needed`);
      }

      let verdict = 'detected';   // no model: every utterance goes on, and the transcript decides
      if (wakeStream && !followUp) {
        const now = Date.now();
        // The peak is read (and reset) once per utterance, whatever the verdict,
        // so a good score cannot leak into a later utterance.
        const peak = wakeStream.takePeak();
        const decision = decideWake({ wakeAt, speechStartedAt, now, durationMs, peak,
          graceMs: OWW_GRACE_MS, candidateThreshold: OWW_CANDIDATE_THRESHOLD });
        verdict = decision.verdict;
        if (verdict === 'candidate') {
          console.log(`[${userId}] [oww] wake candidate (peak score ${peak.toFixed(3)}, ` +
            `threshold ${OWW_THRESHOLD}) — transcribing to confirm`);
        } else if (verdict === 'discard') {
          // The model's best score across the discarded utterance. If you spoke
          // the wake word and this reads 0.2x, the threshold is too high. If it
          // reads 0.00x, the model did not react to your voice at all and no
          // threshold will help.
          console.log(
            `[${userId}] utterance discarded — no wake word ` +
            `(${Math.round(durationMs)}ms, peak score ${peak.toFixed(3)}, ` +
            `threshold ${OWW_THRESHOLD})`
          );
          // A detection that exists but fails the window check is the single
          // most confusing failure mode — the user said the wake word, saw it
          // logged, and got nothing. Say why. (Silence when wakeAt === 0 is
          // normal: that is just ordinary conversation being filtered out.)
          if (wakeAt > 0) {
            console.warn(
              `[${userId}] DISCARDED despite detection — ` +
              `wake was ${now - wakeAt}ms ago, speech began ${now - speechStartedAt}ms ago, ` +
              `utterance ${Math.round(durationMs)}ms, span ${Math.round(decision.span)}ms. ` +
              'Raise OWW_GRACE_MS if this looks wrong.'
            );
          }
          flushing = false;
          return;
        }
      }

      console.log(`[${userId}] Processing ${Math.round(durationMs)}ms utterance...`);
      onUtterance(pcm, userId, connection, channel, followUp || (wakeStream ? verdict === 'detected' : false), verdict === 'candidate' && !followUp)
        .finally(() => { flushing = false; });
    }

    // Discord stops sending packets during true silence, so the segmenter's
    // silence timer alone can miss the end of speech. Every 100 ms:
    const dataWatchdog = timers.setInterval(() => {
      // …no data for SILENCE_MS while speaking ends the utterance;
      if (segmenter.speaking && Date.now() - lastDataTime > SILENCE_MS) {
        flushUtterance();
      }

      // …an utterance that never sees a silence gap is cut off;
      if (segmenter.speaking && Date.now() - segmenter.speechStartedAt > MAX_SPEECH_MS) {
        console.warn(
          `[${userId}] ${Math.round(MAX_SPEECH_MS / 1000)}s of continuous speech with no ` +
          'silence gap — forcing flush. ENERGY_THRESHOLD is likely below your background ' +
          'noise floor, or Luna is hearing herself through your speakers.'
        );
        segmenter.stopSilenceTimer();
        flushUtterance();
        // If the flush was refused — already flushing, or nothing buffered —
        // reset anyway so this does not re-fire every 100 ms.
        if (segmenter.speaking) segmenter.abandon();
      }

      // …and a request that never returns releases this speaker. `flushing` is
      // cleared in onUtterance's .finally(); if a Whisper or LM Studio call
      // never settles it stays true forever and this user goes permanently deaf
      // with no error logged. Self-heal, and say so loudly.
      if (flushing && Date.now() - flushStartedAt > STUCK_FLUSH_MS) {
        console.error(
          `[${userId}] flush stuck for ${Math.round((Date.now() - flushStartedAt) / 1000)}s ` +
          '— releasing. A Whisper or LM Studio request almost certainly never returned.'
        );
        flushing = false;
        flushStartedAt = 0;
        // onUtterance's own guard is released in the same .finally() that
        // never ran — without this every later utterance is still dropped as
        // "previous one still being processed" and the self-heal heals nothing.
        onStuck(userId);
      }
    }, 100);

    audioStream.once('close', () => {
      console.log(`[${userId}] capture stream closed — will resume on next speech`);
      timers.clearInterval(dataWatchdog);
      clearTimeout(listenTimer);
      segmenter.close();
      if (wakeStream) {
        userGainState.set(userId, wakeStream.exportGainState());
        wakeStream.close();
      }
      captureStates.delete(userId);
      listeningUsers.delete(userId);
      // Stream closed — speaking.start will re-trigger continuousCapture next time user speaks
    });

    audioStream.once('error', err => {
      console.error(`[${userId}] capture stream error:`, err);
      timers.clearInterval(dataWatchdog);
      clearTimeout(listenTimer);
      segmenter.close();
      if (wakeStream) wakeStream.close();
      captureStates.delete(userId);
      listeningUsers.delete(userId);
    });
  }

  // ─── Health ─────────────────────────────────────────────────────────────────
  //
  // Called every 30 s: report enough per-speaker state to tell apart the three
  // ways this can silently stop working: audio stopped arriving, the detector
  // wedged, or `flushing` got stuck holding the gate shut.
  function healthReport() {
    if (captureStates.size === 0) return;

    const now = Date.now();
    const parts = [];
    const crypto = session.cryptoState();
    if (crypto) parts.push(`enc[${crypto.status}, epoch ${crypto.epoch ?? '-'}, ${crypto.members ? crypto.members.size : '?'} in group]`);
    for (const [uid, s] of captureStates) {
      const ws = s.wakeStream;
      // Snapshot here too, not only on close: a crash or an ungraceful stream
      // teardown would otherwise discard everything learned about this speaker.
      if (ws) userGainState.set(uid, ws.exportGainState());
      parts.push(
        `${uid.slice(-5)}[` +
        `audio ${((now - s.lastData) / 1000).toFixed(0)}s ago, ` +
        `frames ${ws ? ws.chunksProcessed : 'n/a'}, ` +
        `peak30s ${ws ? ws.takeHealthPeak().toFixed(3) : 'n/a'}, ` +
        `qdepth ${ws ? ws.queueDepth : 'n/a'}, ` +
        `flushing ${s.flushing}, ` +
        `buffered ${s.buffered}` +
        (crypto ? `, ${session.cryptoVerdict(crypto, uid).text}` : '') + ']'
      );
    }
    console.log('[health] ' + parts.join(' '));
  }

  // Starts listening on a connection: to whoever speaks from now on, and to
  // everyone already in the channel.
  function start(connection, channel, textChannel) {
    listenOn(connection, textChannel);
    channel.members.forEach(member => {
      if (member.user.bot)               return;
      if (isIgnored(member.id))          return;
      if (listeningUsers.has(member.id)) return;
      listeningUsers.add(member.id);
      continuousCapture(connection, member.id, textChannel);
    });
  }

  // Luna left: forget the captures (their streams close with the connection).
  function reset() {
    listeningUsers.clear();
    captureStates.clear();
  }

  // After "did you mean to ask me something?": this speaker's next words, for
  // `ms`, are the question without the wake word.
  function expectQuestion(userId, ms) {
    captureStates.get(userId)?.expectQuestion(ms);
  }

  return { initWakeWord, start, reset, expectQuestion, healthReport };
}

module.exports = { createListener };
