// ─── Voice answers ────────────────────────────────────────────────────────────
//
// From an utterance that passed the wake word to Luna's spoken answer:
//   onUtterance   transcribe it (whisper.js), confirm the wake word, and ask
//                 "did you mean to ask me something?" after a bare "hey Luna";
//   answer        route the question (commands.js): a music command or
//                 "leave" is done at once; anything else goes to the LLM
//                 (answer-llm.js), and its answer is spoken sentence by
//                 sentence as it is written, with the chime, the search
//                 heads-up, "still thinking" fillers, the thinking limit and
//                 its quick-answer retry, and barge-in.
//
// createVoiceAnswerer(deps) → { onUtterance, answer, release }.
//   llm, playback, session, whisper   the modules
//   fetchTTS                          tts.js
//   sendCommand(channel, command, requesterId)   post a smakbot command, credited to them
//   leave(userId)                     leave the voice channel at their request
//   expectQuestion(userId, ms, why)   voice-listen.js: their next words are the question
//   nowPlaying                        now-playing.js: "what song is this?"

const path = require('path');
const { route, LEAVE_PHRASES } = require('./commands');
const { condenseSearchResults } = require('./answer-llm');
const { createAnswerFilter } = require('./answer-filter');
const { QUICK_PROMPT } = require('./prompt');
const { parseWaits } = require('./config');
const { isBareWake, confirmWake, isJunkTranscript } = require('./voice-input');
const { shuffle, fillPhrase, speakableName } = require('./phrases');

function createVoiceAnswerer({ config, console, llm, playback, session, whisper, fetchTTS, sendCommand, leave, expectQuestion, nowPlaying }) {
  // ─── Settings ───────────────────────────────────────────────────────────────

  // A bare "hey Luna" (nothing followed, even after WAKE_LISTEN_MS): she asks
  // what they wanted (WAKE_REPROMPT_PHRASES) instead of answering a greeting,
  // then that speaker has WAKE_FOLLOWUP_MS after she finishes to start the
  // question, without the wake word. 0 answers the greeting, as before.
  const WAKE_FOLLOWUP_MS = config.WAKE_FOLLOWUP_MS;
  const REPROMPTS = config.WAKE_REPROMPT_PHRASES.length ? config.WAKE_REPROMPT_PHRASES : [
    "Hey {name}, I didn't catch that. Did you mean to ask me something?",
    "Sorry {name}, I missed that. What did you want to ask?",
    "Hey, I didn't catch that. Did you mean to ask me something?",
  ];

  // Spoken heads-up when a question is going to a web search — the slowest kind
  // of answer, where silence most reads as Luna not having heard. Audio tags are
  // performed by ElevenLabs v3/v4 and stripped for Kokoro.
  const ANNOUNCE_SEARCH = config.ANNOUNCE_SEARCH;
  const SEARCH_PHRASES  = (() => {
    const custom = config.SEARCH_PHRASES;
    return custom.length ? custom : [
      'Let me search for that.',
      '[curious] Hmm, let me take a look.',
      "One sec, I'll check the web.",
      '[thoughtful] Good question. Let me look that up.',
      'Hang on, let me find out.',
    ];
  })();

  // "Still thinking" fillers: while no answer has started, Luna says one after a
  // random wait, then more, backing off: THINKING_WAITS lists the wait window
  // (in seconds) for the 1st, 2nd, ... filler, and the last window repeats.
  // The default "15-22,22-30,30-40" means 15-22 s, then 22-30 s, then every
  // 30-40 s. Random within each window, because a varied gap sounds less
  // mechanical than a fixed beat; backing off, because the longer a wait gets,
  // the less a frequent reminder adds. THINKING_MAX > 0 caps the count. They stop the moment the answer's
  // first sentence is ready. Big models that reason (and search) before
  // answering can be silent for a minute or more, which otherwise sounds exactly
  // like being ignored.
  //
  // A phrase containing {name} is spoken with the asker's name, so mixing a few
  // of those into the list makes some fillers personal. They are skipped when
  // the name has nothing pronounceable in it.
  const ANNOUNCE_THINKING    = config.ANNOUNCE_THINKING;
  const THINKING_WAITS       = parseWaits(config.THINKING_WAITS);
  const THINKING_MAX         = config.THINKING_MAX; // 0 = no limit

  const THINKING_PHRASES     = (() => {
    const custom = config.THINKING_PHRASES;
    return custom.length ? custom : [
      'Still thinking.',
      '[thoughtful] Hmm, give me a moment.',
      'Almost there, bear with me.',
      "This one's taking a bit. Hang tight.",
      'Just a little longer.',
      "Hey {name}, I'm still working on that. I didn't forget about you.",
      'Still on it, {name}. Thanks for your patience.',
    ];
  })();

  // Resolved against this file, not the working directory, so running Luna
  // from elsewhere still finds it.
  const CHIME_PATH = path.join(__dirname, 'chime.mp3');

  // Thinking limit. The LLM's own timeouts (answer-llm.js) can't catch a model
  // that keeps reasoning: reasoning streams, so the request is never idle. One question spent over
  // seven minutes (3,210 reasoning tokens) before its first word. If, before the
  // answer starts, the model has spent LLM_THINK_LIMIT_MS actually *reasoning*,
  // the request is cancelled and asked again with reasoning off, which answers
  // in seconds. 0 disables.
  //
  // Only reasoning counts — LM Studio marks it with reasoning.start/.end events.
  // Searching and reading the results do not: a searched question can spend a
  // minute on those alone (results are read at ~90 tokens/s on this hardware),
  // and counting them cancelled healthy searches and redid them from scratch.
  const LLM_THINK_LIMIT_MS = config.LLM_THINK_LIMIT_MS;
  const QUICK_ANSWER_PHRASES = (() => {
    const custom = config.QUICK_ANSWER_PHRASES;
    return custom.length ? custom : [
      "Sorry, I was overthinking that one. Here's the quick answer.",
      'Okay, let me give you the short version.',
    ];
  })();

  // ─── From utterance to question ──────────────────────────────────────────────

  // Processing a speaker's utterance right now: a second one waits its turn.
  const processingUsers = new Set();

  async function processUtterance(pcm, userId, connection, channel, wakeDetected = false, wakeCandidate = false) {
    if (processingUsers.has(userId)) {
      console.warn(`[${userId}] utterance dropped — previous one still being processed`);
      return;
    }
    processingUsers.add(userId);

    const t0 = Date.now(); // timing: clock starts when the utterance is flushed

    try {
      const transcript = await whisper.transcribe(pcm);
      console.log(`[${userId}] [timing] Whisper done: ${Date.now() - t0}ms`);
      await handleTranscript(transcript, userId, connection, channel, t0, { wakeDetected, wakeCandidate });
    } catch (err) {
      console.error(`[${userId}] Error processing utterance:`, err);
    } finally {
      processingUsers.delete(userId);
    }
  }

  // A "hey Luna" the wake-word model missed, which Whisper heard in the
  // rejected utterance (wake-shadow.js, WAKE_WHISPER_BACKUP). Answered like a
  // detected one — unless the person has been answered again since (they said
  // it again and the model caught it this time), or is being answered now.
  const lastAskedAt = new Map();   // userId -> when their last question was accepted
  async function answerMissedWake(transcript, userId, connection, channel, heardAt) {
    if (processingUsers.has(userId) || (lastAskedAt.get(userId) || 0) > heardAt) {
      console.log(`[${userId}] [wake] a missed "hey Luna" was caught, but they've asked again since — not answering it twice`);
      return;
    }
    processingUsers.add(userId);
    try {
      await handleTranscript(transcript, userId, connection, channel, Date.now(), { wakeCandidate: true });
    } catch (err) {
      console.error(`[${userId}] Error answering a missed wake word:`, err);
    } finally {
      processingUsers.delete(userId);
    }
  }

  // After transcription: noise, the wake word, a bare "hey Luna", or a question.
  async function handleTranscript(transcript, userId, connection, channel, t0, { wakeDetected = false, wakeCandidate = false } = {}) {
    if (!transcript) return;
    // Noise, not words ("[BLANK_AUDIO]", "(coughs)", "Um."): nothing to answer.
    if (isJunkTranscript(transcript)) {
      console.log(`[${userId}] heard no words (${JSON.stringify(transcript.slice(0, 40))}) — nothing to answer`);
      return;
    }

    // The question: the wake phrase removed, or nothing if a candidate turns
    // out to have no "Luna" in it (see confirmWake in voice-input.js).
    const confirmed = confirmWake(transcript, { detected: wakeDetected, candidate: wakeCandidate });
    if (!confirmed.accepted) {
      if (wakeCandidate) {
        console.log(`[${userId}] [oww] wake candidate rejected — ${confirmed.reason} ` +
          `(${transcript.split(/\s+/).length} words)`);
      }
      return;
    }
    if (wakeCandidate) console.log(`[${userId}] [oww] wake candidate confirmed by Whisper`);
    const query = confirmed.query;

    // Only "hey Luna", even after waiting for more: ask what they wanted.
    if (WAKE_FOLLOWUP_MS > 0 && isBareWake(transcript)) {
      askForQuestion(userId, connection);
      return;
    }

    console.log(`[${userId}] Query:`, query);
    lastAskedAt.set(userId, Date.now());
    await handleQuery(query, connection, channel, t0, userId);
  }

  // "Hey smakus, I didn't catch that. Did you mean to ask me something?" — then
  // that speaker's next words, if they start within WAKE_FOLLOWUP_MS of her
  // finishing, are taken as the question without the wake word. (Until she has
  // finished, the window stays open, so an early answer still counts.)
  function askForQuestion(userId, connection) {
    const name = speakableName(session.channel?.members?.get(userId)?.displayName);
    const fitting = REPROMPTS.filter(p => p.includes('{name}') === Boolean(name));
    const text = fillPhrase(fitting.length ? fitting : REPROMPTS, { name });
    console.log(`[${userId}] only "hey Luna" — asking: "${text}"`);
    const expect = ms => expectQuestion(userId, ms, 'the question after "did you mean to ask me something?"');
    expect(60000);
    playback.say(text, { connection, userId, generation: playback.interrupt(userId), then: () => expect(WAKE_FOLLOWUP_MS) });
  }

  // ─── Answering ───────────────────────────────────────────────────────────────

  async function handleQuery(query, connection, channel, t0 = Date.now(), userId = 'unknown') {
    const what = route(query, { voice: true });
    if (what.type === 'music') {
      // Supersede this speaker's own pending audio BEFORE the chime. A
      // VoiceConnection has exactly one subscription, and playback.playSound() creates its
      // own player and subscribes — so an unconditional chime detaches whatever
      // sentence is mid-playback, including another speaker's.
      const musicGeneration = playback.interrupt(userId);
      if (!playback.busy) {
        playback.playSound(CHIME_PATH, connection).catch(() => {});
      }

      await sendCommand(channel, what.command, userId);

      if (what.command.ack) playback.say(what.command.ack, { connection, userId, generation: musicGeneration });
      return;
    }

    // "What song is this?": answered from smakbot, like a command. (Without a
    // MUSIC_STATUS_URL it goes to the LLM like any question.)
    if (what.type === 'now-playing' && nowPlaying?.enabled) {
      const generation = playback.interrupt(userId);
      if (!playback.busy) playback.playSound(CHIME_PATH, connection).catch(() => {});
      const text = nowPlaying.describe(await nowPlaying.get(session.channel?.guild?.id || ''));
      console.log(`[${userId}] [music] now playing → "${text}"`);
      playback.say(text, { connection, userId, generation });
      return;
    }

    // "Leave", "go away", "bye": a goodbye, then out — before the LLM, like the
    // music commands. (Wordier requests reach the LLM's leave_channel tool.)
    if (what.type === 'leave') {
      playback.say(fillPhrase(LEAVE_PHRASES, {}), { connection, userId, generation: playback.interrupt(userId),
                                                    then: () => leave(userId) });
      return;
    }

    // Supersede only this speaker's own pending response. Anyone else's queued
    // sentences survive and play in turn.
    const myGeneration = playback.interrupt(userId);

    // Fire chime (don't await — let it play while we fetch the LLM response).
    //
    // Skipped while audio is already playing. playback.playSound() creates its own
    // AudioPlayer and calls connection.subscribe(), and a VoiceConnection has
    // exactly one subscription — so an unconditional chime silently detached
    // whichever sentence was mid-playback. With several people in a channel that
    // presented as Luna's answers being randomly truncated.
    // Whether the model is offered the web search tool. It decides itself
    // whether to use it; `let`, because a question it tried to search without
    // the tool is asked again with it (see the pass loop).
    let useSearch = llm.offerSearch(query);

    if (!playback.busy) {
      playback.playSound(CHIME_PATH, connection).catch(() => {});
    }

    // Not awaited: posting (and later deleting) this message are Discord round
    // trips of 100-300 ms each, and both used to sit directly in front of the
    // LLM request and the first sentence's TTS.
    const statusMsg = channel.send('🤔 *Luna is thinking...*').catch(() => null);
    let statusCleared = false;
    const clearStatus = () => {
      if (statusCleared) return;
      statusCleared = true;
      statusMsg.then(m => m && m.delete()).catch(() => {});
    };

    // A one-off line tied to this question — the search heads-up and the
    // "still thinking" fillers. Each is its own queue entry, ahead of the
    // answer's: making it the answer's first sentence would enqueue the answer
    // immediately, and that entry would then hold the shared queue for the whole
    // wait, blocking other speakers. Same generation as the answer, so a barge-in
    // skips it too, as does `wanted()` turning false while it waits.
    const sayAside = (tag, phrase, wanted = () => true) => {
      console.log(`[${userId}] [${tag}] "${phrase}"`);
      playback.queue(async () => {
        if (!wanted()) return;
        const pt = await fetchTTS(phrase);
        if (!pt) return;
        if (!wanted() || !playback.isCurrent(userId, myGeneration)) { pt.destroy(); return; }
        await playback.play(pt, connection);
      }, userId, myGeneration);
    };

    // Search heads-up, said when the model actually starts a web search (its
    // first tool call), once per question. Predicting it from keywords before
    // the request announced searches that never happened and missed ones that
    // did; this way it is heard if and only if Luna really is searching.
    let searchAnnounced = false;
    const announceSearchNow = () => {
      if (searchAnnounced) return;
      searchAnnounced = true;
      if (!statusCleared) {
        statusMsg.then(m => m && !statusCleared && m.edit('🔍 *Luna is searching the web...*')).catch(() => {});
      }
      // Skipped if the answer has already started: queued behind it, it would
      // only play once the answer had finished.
      if (ANNOUNCE_SEARCH) sayAside('search', fillPhrase(SEARCH_PHRASES, {}), () => firstSentence);
    };

    // "Still thinking" fillers while no answer has started. Each pass through
    // the phrases is freshly shuffled, so nothing repeats until every phrase
    // has been used, and never twice in a row across passes.
    let answerStarted = false;
    let fillerTimer   = null;
    let fillersSaid   = 0;
    const askerName = speakableName(session.channel?.members?.get(userId)?.displayName);
    const usable = THINKING_PHRASES.filter(p => askerName || !p.includes('{name}'));
    let deck = [];
    let lastFiller = null;
    const nextFiller = () => {
      if (!deck.length) {
        deck = shuffle(usable);
        if (deck.length > 1 && deck[0] === lastFiller) deck.push(deck.shift());
      }
      return (lastFiller = deck.shift());
    };
    const stopFillers = () => {
      answerStarted = true;
      clearTimeout(fillerTimer);
    };
    const scheduleFiller = () => {
      if (!ANNOUNCE_THINKING || !usable.length) return;
      if (THINKING_MAX > 0 && fillersSaid >= THINKING_MAX) return;
      const [lo, hi] = THINKING_WAITS[Math.min(fillersSaid, THINKING_WAITS.length - 1)];
      const wait = lo + Math.random() * (hi - lo);
      fillerTimer = setTimeout(() => {
        if (answerStarted || !playback.isCurrent(userId, myGeneration)) return;
        fillersSaid++;
        // The wait is in the log tag ("[thinking +17.3s]"), so the spacing can
        // be checked from the logs.
        sayAside(`thinking +${(wait / 1000).toFixed(1)}s`,
          nextFiller().replaceAll('{name}', askerName), () => !answerStarted);
        scheduleFiller();
      }, wait);
    };
    scheduleFiller();

    // ── Per-response playback ───────────────────────────────────────────────
    //
    // ONE entry goes on the global chain for the whole response, not one per
    // sentence. With per-sentence entries two speakers' answers braid together
    // — A1, B1, A2, B2 — which is worse than the bug this design replaced.
    //
    // TTS for each sentence is requested as soon as it is within TTS_LOOKAHEAD
    // of playback (see voice-playback.js), so synthesis still overlaps playback.
    // Only playback order is serialised.
    const response = playback.startResponse(userId);
    let streamDone = false;
    let wake       = null;    // resolver signalling "more sentences available"

    const signal = () => { if (wake) { wake(); wake = null; } };

    // Enqueued LAZILY, on the first sentence — never at query time.
    //
    // The entry parks at the head of the shared chain while it waits for more
    // sentences. Enqueuing it up front would therefore hold that head for the
    // entire LLM generation (up to LM_TIMEOUT_MS) while producing no
    // audio at all, blocking every other speaker. Ordering is unaffected: the
    // chain still serialises whole responses, just from first audio rather than
    // from first keystroke.
    let queued = false;
    const ensureQueued = () => {
      if (queued) return;
      queued = true;

      playback.queue(async () => {
        let i = 0;
        let firstAudio = true;

        try {
          while (true) {
            if (i < response.size) {
              if (!playback.isCurrent(userId, myGeneration)) return;

              const passThrough = await response.take(i++);

              // Re-check AFTER the await: a barge-in can land while TTS is still
              // rendering, and without this the superseded sentence plays anyway.
              if (!playback.isCurrent(userId, myGeneration)) {
                passThrough?.destroy();
                return;
              }

              if (passThrough) {
                if (firstAudio) {
                  firstAudio = false;
                  console.log(`[${userId}] [timing] First audio start: ${Date.now() - t0}ms`);
                }
                await playback.play(passThrough, connection);
              }
            } else if (streamDone) {
              return;
            } else {
              await new Promise(r => { wake = r; });
            }
          }
        } finally {
          playback.finishResponse(userId, response);
        }
      }, userId, myGeneration);
    };

    // One LLM request per pass, and at most one retry for each reason:
    //   - the model wrote a tool call as text because it was not offered the
    //     search tool -> ask again with search on (same reasoning);
    //   - it thought past LLM_THINK_LIMIT_MS without starting an answer, or
    //     finished with no words at all (it has answered "." after 50 s of
    //     reasoning) -> ask again with reasoning off, which answers in seconds.
    const superseded = () => !playback.isCurrent(userId, myGeneration);
    let reasoning     = llm.reasoning;
    let firstSentence = true;
    let reasoningRetried = false;
    // Search results seen so far (tool_call.success), so a quick-answer retry
    // can answer from them instead of searching all over again.
    const searchCalls = [];
    let context = '';
    let leaveAfterAnswer = false;   // the LLM called leave_channel

    const speak = sentence => {
      console.log('Luna sentence:', sentence);
      if (firstSentence) {
        firstSentence = false;
        console.log(`[timing] First LLM sentence: ${Date.now() - t0}ms`);
        clearStatus();
        stopFillers();
      }
      ensureQueued();
      response.add(sentence);
      signal();
    };

    try {
      for (;;) {
        let fakeToolCall = false;
        // Search may have been paused by an earlier pass of this question.
        if (useSearch && llm.searchPaused()) useSearch = false;
        const cancel = new AbortController();
        playback.trackRequest(userId, cancel);
        // Reasoning clock: runs only between reasoning.start and reasoning.end,
        // so time spent searching and reading results is not counted.
        let thinkLimitHit = false;
        let thinkTimer    = null;
        let reasonedMs    = 0;
        let reasoningAt   = 0;
        const limitActive = () => LLM_THINK_LIMIT_MS > 0 && reasoning !== 'off' && firstSentence;
        // What of the answer gets said is the answer filter's job (see
        // answer-filter.js). Reasoning-off passes that may search hold
        // everything until the end: without reasoning the model narrates its
        // way through searches. (Only those: holding every answer until it is
        // complete would delay all of them.)
        const filter = createAnswerFilter({
          reasoning: reasoning !== 'off',
          holdUntilEnd: reasoningRetried && useSearch,
          speak,
          drop: (kind, text) => console.log(`[${userId}] [LLM] dropped ${{
            narration: 'narration before a search',
            planning:  'its plan, written as the answer',
          }[kind] || 'reasoning that leaked into the answer'} (not spoken): ${text.slice(0, 160)}`),
          cleaned: raw => console.log(`[${userId}] [LLM] cleaned up for speech; as written: ${JSON.stringify(raw.slice(0, 200))}`),
        });
        const onEvent = e => {
          if (e.type === 'reasoning.start' && !reasoningAt) {
            reasoningAt = Date.now();
            if (limitActive()) {
              thinkTimer = setTimeout(() => {
                thinkLimitHit = true;
                cancel.abort(new DOMException(`no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning`, 'AbortError'));
              }, Math.max(0, LLM_THINK_LIMIT_MS - reasonedMs));
            }
          } else if (e.type === 'reasoning.end' && reasoningAt) {
            reasonedMs += Date.now() - reasoningAt;
            reasoningAt = 0;
            clearTimeout(thinkTimer);
          }
          filter.event(e);
        };
        // What the model's tool calls mean (read in answer-llm.js). A search is
        // announced and handled as a search; music and leaving are acted on.
        const onTool = t => {
          if (t.type === 'search') {
            announceSearchNow();
            filter.event({ type: 'tool_call.start' });
          } else if (t.type === 'search-result') {
            searchCalls.push({ query: t.query, output: t.output });
          } else if (t.type === 'music') {
            if (t.command) sendCommand(channel, t.command, userId);
          } else if (t.type === 'leave') {
            console.log(`[${userId}] [voice] the LLM called leave_channel — leaving after the reply`);
            leaveAfterAnswer = true;
          }
        };

        try {
          const extraSystem = reasoningRetried ? QUICK_PROMPT : '';
          for await (const sentence of llm.stream(query, { userId, useSearch, reasoning, signal: cancel.signal, onEvent, onTool,
                                                           context, extraSystem, speaker: config.LM_USE_NAMES ? askerName : '' })) {
            // Abort only if THIS speaker asked something newer mid-stream.
            if (superseded()) break;
            const verdict = filter.text(sentence);
            // A tool call written out as text — the model wanted to search but
            // had no search tool. Never spoken; stop this pass and ask again
            // with search on.
            if (verdict === 'tool-call-as-text') {
              fakeToolCall = true;
              console.warn(`[${userId}] [LLM] model wrote a tool call as text (not spoken): ${sentence.replace(/\s+/g, ' ').slice(0, 120)}`);
              break;
            }
            // The answer has started: the thinking limit no longer applies.
            if (verdict === 'ok') clearTimeout(thinkTimer);
          }
          // Whatever is still held was answer. (Not after a tool call written
          // as text: what came before it is narration.)
          if (!superseded() && !fakeToolCall) filter.end();
        } catch (err) {
          // The thinking limit is a planned cancel; anything else (including a
          // supersede) is handled below.
          if (!thinkLimitHit || superseded()) throw err;
        } finally {
          clearTimeout(thinkTimer);
          playback.untrackRequest(userId, cancel);
        }

        if (superseded()) break;
        if (fakeToolCall && !useSearch && llm.canSearch()) {
          console.warn(`[${userId}] [LLM] model tried to search without the search tool — asking again with web search`);
          useSearch = true;
          continue;
        }
        if (!firstSentence || reasoning === 'off' || reasoningRetried) break;
        if (thinkLimitHit) {
          console.warn(`[${userId}] [LLM] no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning — asking again with reasoning off`);
          sayAside('quick', fillPhrase(QUICK_ANSWER_PHRASES, {}), () => firstSentence);
        } else {
          console.warn(`[${userId}] [LLM] answer had ${fakeToolCall ? 'only a tool call written as text' : 'no words'} — asking again with reasoning off`);
        }
        reasoning = 'off';
        reasoningRetried = true;
        if (searchCalls.length) {
          // Answer from what was already found: searching again redid minutes
          // of work, and a reasoning-off model narrates its way through searches.
          context = 'Web search results already found for this question (answer from these; do not search again):\n' +
            condenseSearchResults(searchCalls);
          useSearch = false;
          console.log(`[${userId}] [LLM] quick answer reuses ${searchCalls.length} search result set(s); search not offered again`);
        }
      }

      if (firstSentence && !superseded()) {
        stopFillers();
        ensureQueued();
        response.add('Sorry, I lost my train of thought.');
        signal();
      }
    } catch (err) {
      stopFillers();
      if (superseded()) {
        // Barge-in or a newer question: the cancel is the point, not an error.
        console.log(`[${userId}] previous question cancelled`);
      } else {
        console.error('handleQuery error:', err.message);
        // Only when nothing has been said yet. After part of an answer has
        // played, a tacked-on "I had trouble processing that." makes a merely
        // truncated answer sound like a failure.
        if (response.size === 0) {
          ensureQueued();
          response.add(err.name === 'TimeoutError'
            ? 'Sorry, that took too long to work out.'
            : 'I had trouble processing that.');
          signal();
        }
      }
    } finally {
      clearStatus();
      stopFillers();
      // MUST run on every path. The queue entry above parks on `wake`, and if
      // it is never released it blocks the global playback chain for every
      // speaker, forever.
      streamDone = true;
      signal();
      // Never queued (no sentence, or superseded first): nothing will consume it.
      if (!queued) playback.finishResponse(userId, response);
      // Queued behind the answer, so she leaves once her goodbye has played.
      if (leaveAfterAnswer && !superseded()) playback.queue(async () => leave(userId), userId, myGeneration);
    }
  }


  // A speaker's request never returned (voice-listen.js gave up on it): let
  // their next utterance through.
  const release = userId => processingUsers.delete(userId);

  return {
    onUtterance: processUtterance, answer: handleQuery, release, answerMissedWake,
    // The parsed settings, for the tests.
    settings: { thinking: { waits: THINKING_WAITS, cap: THINKING_MAX }, thinkLimit: LLM_THINK_LIMIT_MS },
  };
}

module.exports = { createVoiceAnswerer };
