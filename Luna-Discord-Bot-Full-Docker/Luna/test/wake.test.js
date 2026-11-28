// Hearing "hey Luna": barge-in, two-stage detection, a bare "hey Luna", follow-up windows, the Whisper backup and the wake-word log; playback cut short.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('barge-in while thinking (real capture path)');
  { const H = boot({ SILENCE_MS: '300', MIN_SPEECH_MS: '100', ANNOUNCE_THINKING: 'false', ANNOUNCE_SELF: 'false', LLM_THINK_LIMIT_MS: '0' });
    await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20);
    const mic = H.S.audio.u1, wake = H.S.wake.u1; assert.ok(mic && wake, 'capture + wake stream created');
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    const speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
    H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.aborted = 0;
    H.S.transcripts = ['tell me about camptown races', 'actually never mind, tell me a joke'];
    H.S.llmScripts = [[...reasoningDeltas(60, 50), ...sse('Old long answer.')], sse('Here is a joke.')];
    wake.onDetect(0.9, Date.now()); await speak(300); await H.until(() => H.S.llmRequests.length === 1);   // question 1 flushed, LLM "thinking"
    assert.strictEqual(H.S.llmRequests.length, 1); assert.strictEqual(H.S.llmRequests[0].input, 'tell me about camptown races');
    await H.wait(500);
    wake.onDetect(0.9, Date.now()); await H.wait(20);                     // "hey Luna" during the think
    assert.ok(H.S.logs.some(l => /barge-in — cancelling the previous question/.test(l))); assert.ok(H.S.aborted >= 1);
    await speak(300); await H.until(() => H.S.tts.some(t => t.text === 'Here is a joke.'));
    assert.strictEqual(H.S.llmRequests.length, 2); assert.strictEqual(H.S.llmRequests[1].input, 'actually never mind, tell me a joke');
    const said = H.S.tts.map(t => t.text);
    assert.ok(said.includes('Here is a joke.') && !said.includes('Old long answer.'));
    assert.ok(H.S.logs.some(l => /previous question cancelled/.test(l)) && !H.S.logs.some(l => /handleQuery error/.test(l)));
    assert.ok(!H.S.logs.some(l => /DISCARDED despite detection/.test(l)));
    ok('"hey Luna" mid-think → old request aborted, new question transcribed and answered; old answer never spoken; no error, nothing discarded'); }


  console.log('two-stage wake detection');
  { const H = await wakeRig();
    assert.ok(H.S.logs.some(l => /\[oww\] active — threshold=.*; candidates from 0\.1 confirmed by Whisper/.test(l)));
    await H.utter(0.41, "Hey Luna what's the weather like today");
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather like today"]);
    assert.ok(H.S.logs.some(l => /wake candidate \(peak score 0\.410/.test(l)) && H.S.logs.some(l => /wake candidate confirmed by Whisper/.test(l)));
    ok('run-on "hey Luna what\'s the weather" (peak 0.41, no full detection) → candidate, Whisper hears Luna → "what\'s the weather like today" answered'); }
  { const H = await wakeRig(); await H.utter(0.12, "So anyway, hey Luna, what's the weather like today?");
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather like today?"]);
    ok('mid-sentence "so anyway, hey Luna, what\'s…" → question after the wake phrase'); }
  { const H = await wakeRig(); await H.utter(0.15, 'I was looking at the lunar eclipse last night');
    assert.strictEqual(H.S.llmRequests.length, 0);
    const rej = H.S.logs.find(l => /wake candidate rejected/.test(l)); assert.ok(rej && /\(9 words; began "I was looking"\)/.test(rej) && !/eclipse/.test(rej), rej);
    assert.deepStrictEqual(H.S.wakeLog.filter(e => e.event === 'rejected').map(e => e.heard), ['I was looking']);
    ok('candidate whose transcript has no "Luna" ("lunar" doesn\'t count) → rejected; the log has a word count and the first three words, not the rest'); }
  { const H = await wakeRig(); H.S.llmScript = sse('They are on.'); await H.utter(0.417, 'Eluna, are the lights on in the kitchen?');
    await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['are the lights on in the kitchen?']);
    assert.ok(H.S.logs.some(l => /wake candidate confirmed by Whisper/.test(l)));
    ok('the live miss: a 0.417 candidate Whisper wrote as "Eluna, are the…" → confirmed and answered'); }
  { const H = await wakeRig(); await H.utter(0.33, 'Hey Lina, play Brick in the Wall by Pink Floyd.');
    assert.strictEqual(H.S.llmRequests.length, 0, 'still not answered (logging only)');
    assert.ok(H.S.logs.some(l => /wake candidate rejected — no "Luna" in the transcript \(10 words; near miss "Hey Lina"\)/.test(l)), H.S.logs.filter(l => /rejected/.test(l)).join(' | '));
    assert.deepStrictEqual(H.S.wakeLog.filter(e => e.event !== 'discarded').map(e => [e.event, e.heard]), [['candidate', undefined], ['rejected', 'Hey Lina'], ['near-miss', 'Hey Lina']]);
    ok('a near-threshold "Hey Lina, play…" → still rejected, but logged as a near miss "Hey Lina" (and counted in wakestats)'); }
  { const H = await wakeRig(); await H.utter(0.05, "Hey Luna what's the weather");
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.logs.some(l => /Processing \d+ms utterance/.test(l)));
    assert.ok(H.S.logs.some(l => /utterance discarded — no wake word \(\d+ms, peak score 0\.050/.test(l)));
    ok('peak below the candidate threshold (0.05) → discarded without transcribing, as before'); }
  { const H = await wakeRig({ OWW_CANDIDATE_THRESHOLD: '0' }); await H.utter(0.3, "Hey Luna what's the weather");
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.logs.some(l => /candidates from/.test(l)));
    ok('OWW_CANDIDATE_THRESHOLD=0 → two-stage off: peak 0.3 discarded'); }
  { const H = await wakeRig(); await H.utter(0.9, 'tell me a joke', true);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['tell me a joke']); assert.ok(!H.S.logs.some(l => /wake candidate/.test(l)));
    H.S.peaks.u1 = 0.9; await H.utter(0.9, 'tell me another', true);  // a detection's peak is consumed with it...
    H.S.transcripts = ['and now a third']; for (let t = 0; t < 300; t += 20) { H.S.audio.u1.write(Buffer.alloc(1920, 7)); await H.wait(20); } await H.wait(900);
    assert.strictEqual(H.S.llmRequests.length, 2, '...so it cannot make a candidate of the next, wake-word-free utterance');
    ok('full detections unchanged (no Whisper check); their peak is consumed, so it never leaks into the next utterance as a candidate'); }


  console.log('listening after a bare "hey Luna"');
  { const H = await wakeRig({ WAKE_LISTEN_MS: '2000' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    const speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
    H.S.transcripts = ["Hey Luna. What's the weather like?"]; H.S.played.length = 0;
    await speak(300); wake.onDetect(0.9, Date.now());                     // "hey Luna", the model fires as it ends
    await H.until(() => H.S.logs.some(l => /listening for the question/.test(l))); await H.wait(300);   // a pause past SILENCE_MS
    assert.strictEqual(H.S.llmRequests.length, 0, 'not answered as a greeting');
    assert.ok(H.S.logs.some(l => /heard "hey Luna" — listening for the question \(up to 2s\)/.test(l)));
    assert.strictEqual(H.S.played.filter(p => p === undefined).length, 0, 'no chime while she waits');
    await speak(400); await H.until(() => H.S.llmRequests.length > 0);     // the question
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["What's the weather like?"]);
    assert.strictEqual(H.S.played.filter(p => p === undefined).length, 1, 'one chime, once the question is in');
    ok('"hey Luna" … pause … question → one utterance: silent wait, the usual chime after the question, no greeting'); }
  { const H = await wakeRig({ WAKE_LISTEN_MS: '1200' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    const speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
    H.S.transcripts = ["Hey Luna. What will the weather be like on Saturday?"];
    await speak(300); wake.onDetect(0.9, Date.now());
    await H.until(() => H.S.logs.some(l => /listening for the question/.test(l)));   // pause; the wait ends 1.2 s after "Luna"
    await speak(1100);                                                     // a long question, still going when it ends
    assert.strictEqual(H.S.llmRequests.length, 0, 'not cut off when the wait ends mid-question');
    await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['What will the weather be like on Saturday?']);
    ok('a question still being spoken when the wait runs out is not cut off; it ends on its own silence'); }
  { const H = await wakeRig({ WAKE_LISTEN_MS: '1000', WAKE_FOLLOWUP_MS: '0' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    H.S.transcripts = ['Hey Luna.'];
    for (let t = 0; t < 300; t += 20) { mic.write(loud); await H.wait(20); } wake.onDetect(0.9, Date.now());
    await H.until(() => H.S.logs.some(l => /listening for the question/.test(l))); assert.strictEqual(H.S.llmRequests.length, 0);
    await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['Hey Luna.']);
    ok('nothing follows within WAKE_LISTEN_MS (WAKE_FOLLOWUP_MS=0) → the bare "hey Luna" is answered as a greeting'); }
  { const H = await wakeRig(); await H.utter(0.9, "hey Luna what's the weather", true);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather"]);
    assert.ok(!H.S.logs.some(l => /listening for the question/.test(l)));
    ok('run-on "hey Luna what\'s the weather" → no waiting, answered as before'); }
  { const H = await wakeRig({ WAKE_LISTEN_MS: '0', WAKE_FOLLOWUP_MS: '0' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    H.S.transcripts = ['Hey Luna.'];
    for (let t = 0; t < 300; t += 20) { mic.write(loud); await H.wait(20); } wake.onDetect(0.9, Date.now());
    await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['Hey Luna.']); assert.ok(!H.S.logs.some(l => /listening for/.test(l)));
    ok('WAKE_LISTEN_MS=0 → no waiting, as before'); }


  console.log('playback cut short');
  { const H = await setup({}); H.S.llmScript = sse('Hello there.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(!H.S.logs.some(l => /\[audio\] sentence cut short/.test(l)), 'a sentence that plays to its end is not reported');
    H.S.audioRunsDry = true; H.S.llmScript = sse('Cut off here.');
    await H.T.handleQuery('again', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(H.S.logs.some(l => /\[audio\] sentence cut short after 1\.2s — the audio stopped arriving in time/.test(l)), H.S.logs.slice(-5).join(' | '));
    ok('player stops before the audio ended → "[audio] sentence cut short" warning; a normal ending is not reported'); }
  { const H = await setup({}); H.S.playMs = 2000; H.S.audioRunsDry = true; H.S.llmScript = sse('A long sentence that is still playing.');
    await H.T.handleQuery('tell me something', H.S.lastConnection, H.text, Date.now(), 'u1');
    await H.until(() => H.S.played.includes('A long sentence that is still playing.'));   // her sentence, not the chime
    H.T.interruptOwnPlayback('u1'); await H.wait(50);
    assert.ok(!H.S.logs.some(l => /sentence cut short/.test(l)), 'an interruption is not a playback failure');
    ok('interrupting her (barge-in) → no false "sentence cut short" warning'); }


  console.log('"did you mean to ask me something?"');
  { const H = await bareRig(); await H.bareWake();
    assert.strictEqual(H.S.llmRequests.length, 0, 'no greeting from the LLM');
    const asked = H.S.tts.find(t => /didn't catch that|missed that/.test(t.text)).text;
    assert.ok(asked.includes('smakus'), asked); assert.ok(H.S.logs.some(l => /only "hey Luna" — asking/.test(l)));
    H.S.transcripts = ["what's the weather tomorrow"]; (H.S.peaks ??= {}).u1 = 0;      // no wake word this time
    await H.speak(500); await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather tomorrow"]);
    assert.ok(H.S.logs.some(l => /the question after "did you mean to ask me something\?" — no wake word needed/.test(l)));
    H.S.transcripts = ['and some other chatter']; await H.speak(500); await H.wait(900);
    assert.strictEqual(H.S.llmRequests.length, 1, 'only the next utterance counts; then the wake word is needed again');
    ok('bare "hey Luna" → "Hey smakus, I didn\'t catch that…" (no LLM); the next words, without the wake word, are answered; after that the wake word is needed again'); }
  { const H = await bareRig({ WAKE_FOLLOWUP_MS: '300' }); await H.bareWake();
    await H.wait(800); H.S.transcripts = ["what's the weather"]; await H.speak(500); await H.wait(900);
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(H.S.logs.some(l => /utterance discarded — no wake word/.test(l)));
    ok('no answer within WAKE_FOLLOWUP_MS → dropped quietly; later words need the wake word'); }
  { const H = await bareRig(); H.S.transcripts = ["What's the weather, hey Luna."]; await H.speak(300); H.S.wake.u1.onDetect(0.9, Date.now());
    await H.until(() => H.S.llmRequests.length > 0);
    assert.ok(!H.S.tts.some(t => /didn't catch that/.test(t.text)) && H.S.llmRequests.length === 1);
    ok('a question before the wake phrase is answered, not re-prompted'); }


  console.log('follow-up windows');
  { const H = await bareRig({ WAKE_FOLLOWUP_MS: '1500' }); await H.bareWake();
    // Discord closes a quiet speaker's audio stream (after 60 s of silence)…
    H.S.audio.u1.destroy(); await H.until(() => H.S.logs.some(l => /\[smakus\] capture stream closed/.test(l)));
    // …and when they speak again it's a new capture.
    H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.until(() => H.S.audio.u1 && !H.S.audio.u1.destroyed);
    H.S.transcripts = ["what's the weather on Saturday"]; (H.S.peaks ??= {}).u1 = 0;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    for (let t = 0; t < 500; t += 20) { H.S.audio.u1.write(loud); await H.wait(20); }   // into the new stream
    await H.until(() => H.S.llmRequests.length > 0);
    assert.strictEqual(H.S.llmRequests[0].input, "what's the weather on Saturday");
    ok('"did you mean to ask me something?" → their audio stream closed and reopened → the window is still there'); }
  { const H = await bareRig({ WAKE_FOLLOWUP_MS: '200' }); await H.bareWake(); await H.wait(700);
    H.S.transcripts = ['random chatter']; (H.S.peaks ??= {}).u1 = 0; await H.speak(500); await H.wait(900);
    assert.strictEqual(H.S.llmRequests.length, 0);
    assert.ok(H.S.logs.some(l => /utterance discarded — no wake word .* — started \d+\.\ds after the follow-up window closed/.test(l)), H.S.logs.filter(l => /discarded/.test(l)).join(' | '));
    ok('speech just after the window closed → discarded, and the log says by how much it missed'); }

  { const H = await wakeRig({ OWW_AGC_TARGET_RMS: '5200' });
    assert.strictEqual(H.S.wakeLoad.agcTargetRms, 5200); ok('OWW_AGC_TARGET_RMS reaches the wake-word engine (not read from the environment by wakeword.js)'); }

  console.log('wake-word backup and shadow check');
  { const H = await wakeRig({ WAKE_SHADOW: 'true' }); H.S.names = { u1: 'smakus' }; H.put('u1', 'A');
    await H.utter(0.004, "hey Luna what's the weather"); await H.until(() => H.S.logs.some(l => /\[wake\] Whisper heard "hey Luna"/.test(l)));
    assert.strictEqual(H.S.llmRequests.length, 0, 'measured, not answered');
    assert.ok(H.S.logs.some(l => /\[wake\] Whisper heard "hey Luna" from smakus that the model missed \(scored 0\.004;/.test(l)), H.S.logs.slice(-3).join(' | '));
    await H.utter(0.001, 'pass me the chips'); await H.wait(100);
    assert.ok(!H.S.logs.some(l => /\[shadow\].*chips/.test(l)), 'other speech is not logged');
    H.T.wakeBackup.report();
    assert.ok(H.S.logs.some(l => /\[shadow\] last \d+ min: 2 discarded clips transcribed .* dropped 0, failed 0, backlog 0\. Missed "hey Luna": smakus 1\./.test(l)), H.S.logs.slice(-2).join(' | '));
    ok('WAKE_SHADOW: a rejected "hey Luna" Whisper hears → "[shadow] MISSED …" (not answered); other speech not logged; the summary counts clips and misses'); }
  { const H = await wakeRig(); await H.utter(0.004, "hey Luna what's the weather"); await H.wait(100);
    assert.ok(!H.S.logs.some(l => /\[shadow\]|\[wake\]/.test(l))); ok('WAKE_SHADOW and WAKE_WHISPER_BACKUP off (default) → nothing transcribed or logged'); }
  { const H = await wakeRig({ WAKE_WHISPER_BACKUP: 'true' }); H.S.names = { u1: 'smakus' }; H.put('u1', 'A');
    await H.utter(0.004, "hey Luna what's the weather"); await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather"]);
    assert.ok(H.S.logs.some(l => /\[wake\] Whisper heard "hey Luna" from smakus that the model missed .* — answering/.test(l)));
    await H.until(() => H.S.tts.some(t => t.text === 'Sunny all day.'));
    ok('WAKE_WHISPER_BACKUP: a "hey Luna" the model scored 0.004 → Whisper hears it → answered ("what\'s the weather")'); }
  { const H = await wakeRig({ WAKE_WHISPER_BACKUP: 'true' });
    await H.utter(0.004, 'So anyway. Okay Luna, what time is it'); await H.until(() => H.S.llmRequests.length > 0);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['what time is it']);
    assert.ok(!H.S.logs.some(l => /\[oww\] wake candidate/.test(l)), 'not reported as the model\'s candidate');
    ok('WAKE_WHISPER_BACKUP: "So anyway. Okay Luna, what time is it" → the question is what follows "okay Luna"; no [oww] candidate log'); }
  { const H = await wakeRig({ WAKE_WHISPER_BACKUP: 'true' }); H.S.transcriptMs = 300;
    await H.utter(0.004, 'pass me the chips'); await H.wait(200);
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.logs.some(l => /\[wake\]|chips/.test(l.replace(/^\[u1\] (Processing|utterance).*/, ''))));
    ok('WAKE_WHISPER_BACKUP: ordinary chatter → transcribed, not answered, not logged'); }
  { const H = await wakeRig({ WAKE_WHISPER_BACKUP: 'true' });
    const { answerMissedWake } = H.T; const conn = H.S.lastConnection;
    H.S.llmScript = sse('Sunny all day.'); await H.utter(0.9, "what's the weather", true);    // they said it again, and the model caught it
    const before = H.S.llmRequests.length;
    await answerMissedWake("hey Luna what's the weather", 'u1', conn, H.text, Date.now() - 5000);   // the miss, caught late
    assert.strictEqual(H.S.llmRequests.length, before, 'not answered twice');
    assert.ok(H.S.logs.some(l => /a missed "hey Luna" was caught, but they've asked again since/.test(l)));
    ok('a missed "hey Luna" caught after they asked again (and were answered) → not answered twice'); }

  console.log('wake-word log');
  { const H = await wakeRig({ WAKE_WHISPER_BACKUP: 'true' }); H.S.names = { u1: 'smakus' }; H.put('u1', 'A');
    await H.utter(0.012, 'pass me the chips'); await H.wait(150);
    await H.utter(0.006, "hey Lena, what's up"); await H.until(() => H.S.logs.some(l => /near miss/.test(l)));
    await H.utter(0.004, "hey Luna what's the weather"); await H.until(() => H.S.llmRequests.length > 0);
    await H.until(() => (H.S.wakeLog || []).some(e => e.event === 'missed'));
    const events = H.S.wakeLog.map(({ event, who, peak, answered, heard }) => ({ event, who, peak, ...(answered && { answered }), ...(heard && { heard }) }));
    assert.deepStrictEqual(events, [
      { event: 'discarded', who: 'smakus', peak: 0.012 },
      { event: 'discarded', who: 'smakus', peak: 0.006 },
      { event: 'near-miss', who: 'smakus', peak: 0.006, heard: 'hey Lena' },
      { event: 'discarded', who: 'smakus', peak: 0.004 },
      { event: 'missed', who: 'smakus', peak: 0.004, answered: 'yes' },
    ]);
    assert.ok(H.S.wakeLog.every(e => e.file === 'logs/wake.jsonl' && e.id === 'u1' && !('text' in e)), 'no transcripts');
    assert.ok(H.S.logs.some(l => /^\[smakus\] utterance discarded — no wake word/.test(l)), 'names, not IDs');
    assert.ok(H.S.logs.some(l => /\[wake\] near miss from smakus: Whisper heard "hey Lena"/.test(l)));
    assert.strictEqual(H.S.llmRequests.length, 1, 'the near miss is not answered');
    ok('wake-word log: chatter → discarded; "hey Lena" → near miss (logged, not answered); a missed "hey Luna" → missed, answered; names in the log lines; no transcripts'); }
  { const H = await wakeRig(); H.S.names = { u1: 'smakus' }; H.put('u1', 'A');
    await H.utter(0.2, "hey Luna what's the weather"); await H.until(() => H.S.llmRequests.length > 0);
    await H.utter(0.9, "what's the time", true); await H.until(() => H.S.llmRequests.length > 1);
    assert.deepStrictEqual(H.S.wakeLog.map(e => e.event), ['candidate', 'confirmed', 'detected']);
    ok('wake-word log: a candidate Whisper confirms → candidate, confirmed; a detection → detected'); }
  { const H = await wakeRig(); H.S.wakeLogDown = true;
    await H.utter(0.01, 'pass me the chips'); await H.wait(100); await H.utter(0.01, 'more chips'); await H.wait(100);
    assert.strictEqual(H.S.logs.filter(l => /\[wake-log\] can't write/.test(l)).length, 1);
    ok("the wake-word log can't be written → warned once, Luna carries on"); }

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
