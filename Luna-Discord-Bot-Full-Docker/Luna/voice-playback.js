// ─── Playback ─────────────────────────────────────────────────────────────────
//
// Everything Luna says in the voice channel goes through one queue, so
// answers, greetings and announcements never talk over each other.
//
// Responses from different speakers QUEUE and play in order. Each entry
// carries its speaker and that speaker's generation at queue time; when it
// comes up it re-checks, and is skipped if that speaker has since asked
// something newer. Another speaker asking does not affect it. This preserves
// barge-in for the person being answered while preventing speakers from
// cancelling each other.
//
// createPlayback({ voice, fetchTTS, console, lookahead }) → playback.
// voice is @discordjs/voice and fetchTTS is tts.js's, passed in so the test
// harness can fake them.

function createPlayback({ voice, fetchTTS, console, lookahead }) {
  const { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } = voice;

  let queueTail         = Promise.resolve();
  let currentPlayer     = null;
  let currentPlayerUser = null;              // who owns the entry currently playing
  const userGeneration  = new Map();         // userId -> that user's latest generation
  const responses       = new Map();         // userId -> their in-progress SpokenResponse
  const requests        = new Map();         // userId -> AbortController of their LLM request in flight

  // ─── Spoken responses ───────────────────────────────────────────────────────
  //
  // One answer being spoken. Sentences arrive from the LLM; TTS is requested for
  // the sentence about to play plus `lookahead` after it — enough for gapless
  // playback, without synthesising a whole long answer up front. cancel() aborts
  // requests in flight and discards audio that was fetched but not played: on a
  // barge-in, that work used to run to completion (and, on ElevenLabs, be billed)
  // for sentences nobody would hear.
  class SpokenResponse {
    constructor() {
      this.sentences  = [];
      this.fetches    = [];   // Promise<stream|null>, by sentence index
      this.next       = 0;    // index of the next sentence to play
      this.controller = new AbortController();
    }

    get size() { return this.sentences.length; }

    add(sentence) {
      this.sentences.push(sentence);
      this._fill();
    }

    // Resolves to the audio stream for sentence `i` (or null if TTS failed) and
    // moves the lookahead window along.
    async take(i) {
      this.next = i + 1;
      this._fill();
      return this.fetches[i];
    }

    _fill() {
      if (this.controller.signal.aborted) return;
      const limit = Math.min(this.sentences.length, this.next + 1 + lookahead);
      for (let i = this.fetches.length; i < limit; i++) {
        this.fetches.push(fetchTTS(this.sentences[i], { signal: this.controller.signal }));
      }
    }

    cancel() {
      if (this.controller.signal.aborted) return;
      this.controller.abort();
      for (let i = this.next; i < this.fetches.length; i++) {
        this.fetches[i].then(stream => stream?.destroy()).catch(() => {});
      }
    }
  }

  // A speaker's answer starts: theirs to fill, cancelled if they're superseded.
  function startResponse(userId) {
    const response = new SpokenResponse();
    responses.set(userId, response);
    return response;
  }

  function finishResponse(userId, response) {
    if (responses.get(userId) === response) responses.delete(userId);
  }

  // The LLM request answering a speaker, aborted if they're superseded.
  function trackRequest(userId, controller) { requests.set(userId, controller); }
  function untrackRequest(userId, controller) {
    if (requests.get(userId) === controller) requests.delete(userId);
  }

  // ─── Generations ────────────────────────────────────────────────────────────
  //
  // Generations are PER USER, not global.
  //
  // Previously a single global counter meant any new query cancelled every
  // pending sentence regardless of who asked. With several people in a channel
  // that silently ate questions: A asks, B asks, only B gets an answer and A
  // never learns why.
  //
  // Now each speaker has their own generation. A new query supersedes only that
  // speaker's own pending sentences; everyone else's stay queued and play in
  // turn.
  function nextGeneration(userId) {
    const g = (userGeneration.get(userId) || 0) + 1;
    userGeneration.set(userId, g);
    // Superseded: stop synthesising sentences of their answer that will now
    // never play.
    const superseded = responses.get(userId);
    if (superseded) {
      superseded.cancel();
      responses.delete(userId);
    }
    // ...and stop the LLM working on a question nobody is waiting for.
    const request = requests.get(userId);
    if (request) {
      request.abort();
      requests.delete(userId);
    }
    return g;
  }

  // The speaker's current generation (undefined before they first ask).
  const generationOf = userId => userGeneration.get(userId);
  // Whether `generation` is still the speaker's latest.
  const isCurrent = (userId, generation) => userGeneration.get(userId) === generation;

  // ─── The queue ──────────────────────────────────────────────────────────────

  function queue(fn, userId, generation) {
    queueTail = queueTail.then(async () => {
      // Stale only if THIS user has since asked something newer.
      if (userGeneration.get(userId) !== generation) return;
      currentPlayerUser = userId;
      try {
        await fn();
      } finally {
        currentPlayerUser = null;
      }
    }).catch(() => {});
  }

  // Barge-in, scoped to one speaker.
  //
  // Saying the wake word again cuts off *your own* answer — the original intent.
  // It does not stop someone else mid-sentence. Note this deliberately does NOT
  // reset the queue: doing so would drop other speakers' queued responses,
  // which is the bug this replaces.
  function interrupt(userId) {
    const generation = nextGeneration(userId);

    if (currentPlayerUser === userId && currentPlayer) {
      try { currentPlayer.stop(true); } catch (_) {}
      currentPlayer = null;
      currentPlayerUser = null;
    }

    return generation;
  }

  // ─── Playing audio ──────────────────────────────────────────────────────────
  //
  // fetchTTS() (tts.js) starts synthesis and returns a readable audio stream;
  // it is called as soon as a sentence is ready, even while a previous one is
  // still playing, so audio is ready with zero wait. play() subscribes the
  // stream to the Discord player and awaits completion; the queue calls it in
  // order.
  async function play(passThrough, connection) {
    try {
      const player   = createAudioPlayer();
      const resource = createAudioResource(passThrough, {
        inputType: StreamType.Arbitrary,
      });

      currentPlayer = player; // track so interrupt() can stop it
      connection.subscribe(player);
      player.play(resource);

      await new Promise(resolve => {
        let settled = false;

        const finish = (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);              // else it fires mid-way through a LATER
                                            // sentence and nulls that player's handle
          try { player.stop(true); } catch (_) {}
          // Only release the handle if it still refers to THIS player.
          if (currentPlayer === player) currentPlayer = null;
          if (reason) console.error(`playTTS: ${reason}`);
          resolve();
        };

        const timer = setTimeout(() => finish('playback timed out after 30s'), 30000);
        player.on(AudioPlayerStatus.Idle, () => {
          // Idle while the audio has not ended: Discord's player stops a sentence
          // when no audio has arrived for 100 ms, so the rest of it is lost.
          // That happens when TTS renders slower than playback (it was streamed
          // Chatterbox while the LLM was writing). An interruption is not this:
          // interrupt() lets go of currentPlayer first.
          if (currentPlayer === player && resource.playStream && !resource.playStream.readableEnded) {
            console.warn(`[audio] sentence cut short after ${(resource.playbackDuration / 1000).toFixed(1)}s — ` +
              'the audio stopped arriving in time (TTS rendering slower than playback?)');
          }
          finish();
        });
        player.on('error', err => finish(err.message));
      });
    } catch (err) {
      console.error('playTTS error:', err);
      currentPlayer = null;
    }
  }

  // A short sound (the chime), outside the queue.
  async function playSound(filePath, connection) {
    try {
      const player   = createAudioPlayer();
      const resource = createAudioResource(filePath, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      resource.volume?.setVolume(0.2);
      connection.subscribe(player);
      player.play(resource);
      await new Promise(resolve => {
        player.on(AudioPlayerStatus.Idle, () => { player.stop(); resolve(); });
        player.on('error', () => resolve()); // don't block if file missing
        setTimeout(resolve, 5000);           // safety timeout
      });
    } catch (_) {}
  }

  // Forgets everything (Luna left the voice channel): answers in progress are
  // cancelled, their LLM requests aborted, the queue emptied.
  function reset() {
    for (const response of responses.values()) response.cancel();
    responses.clear();
    for (const request of requests.values()) request.abort();
    requests.clear();
    userGeneration.clear();
    queueTail         = Promise.resolve();
    currentPlayer     = null;
    currentPlayerUser = null;
  }

  return {
    queue, interrupt, nextGeneration, generationOf, isCurrent,
    play, playSound,
    startResponse, finishResponse, trackRequest, untrackRequest,
    reset,
    // Something is playing now (an answer, greeting or announcement).
    get busy() { return !!currentPlayer; },
    responses,
  };
}

module.exports = { createPlayback };
