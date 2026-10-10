// The voice-input stages (voice-input.js), each on its own, with a fake clock.
// luna.test.js covers them wired together in the real capture path.
// Run: node --test test/   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const v = require('../voice-input');

// A 20 ms frame (960 samples, 16-bit mono) at a constant level.
const frame = level => { const b = Buffer.alloc(1920); for (let i = 0; i < 960; i++) b.writeInt16LE(level, i * 2); return b; };
const LOUD = frame(2000), QUIET = frame(10);

// A clock and timers the test advances by hand.
function fakeTime(start = 1000) {
  let t = start; const timers = [];
  return {
    now: () => t,
    advance(ms) { t += ms; for (const tm of timers.filter(x => !x.done && x.at <= t)) { tm.done = true; tm.fn(); } },
    setTimer: (fn, ms) => { const tm = { fn, at: t + ms, done: false }; timers.push(tm); return tm; },
    clearTimer: tm => { if (tm) tm.done = true; },
  };
}

describe('packet decoder', () => {
  it('decodes good packets, drops bad ones, and keeps decoding after them', () => {
    const out = [], reports = [];
    const decoder = { decode: p => { if (p === 'bad') throw new Error('corrupted'); return `pcm:${p}`; } };
    const time = fakeTime(1e6);   // like the real clock: far from zero, so the first drop is reported at once
    const decode = v.createPacketDecoder(decoder, { onPcm: x => out.push(x), onUndecodable: n => reports.push(n), now: time.now });
    decode('a'); decode('bad'); decode('b');
    assert.deepStrictEqual(out, ['pcm:a', 'pcm:b']);
    assert.deepStrictEqual(reports, [1]);
  });
  it('reports drops at most every 10 s, with the count since the last report', () => {
    const reports = [], time = fakeTime(1e6);
    const decode = v.createPacketDecoder({ decode: () => { throw new Error('x'); } }, { onPcm() {}, onUndecodable: n => reports.push(n), now: time.now });
    decode(1); decode(2); decode(3); time.advance(10000); decode(4);
    assert.deepStrictEqual(reports, [1, 3]);
  });
});

describe('wake feeder', () => {
  it('writes the silence Discord skipped before a frame, capped', async () => {
    const writes = [], time = fakeTime();
    const stream = { write: b => { writes.push(b.length); return Promise.resolve(0.5); } };
    const feed = v.createWakeFeeder(stream, { frameMs: 20, maxFillMs: 2000, now: time.now });
    assert.strictEqual(await feed(LOUD), 0.5);
    time.advance(20); await feed(LOUD);           // on time: nothing filled
    time.advance(520); await feed(LOUD);          // 500 ms gap beyond the frame
    time.advance(10000); await feed(LOUD);        // capped at 2 s
    assert.deepStrictEqual(writes, [1920, 1920, 500 / 1000 * 48000 * 2, 1920, 2000 / 1000 * 48000 * 2, 1920]);
  });
});

describe('segmenter', () => {
  const make = (time, extra = {}) => {
    const flushed = [];
    const seg = v.createSegmenter({ energyThreshold: 300, prerollFrames: 3, frameMs: 20, maxFrames: 50, silenceMs: 1000,
      onSilence: () => flushed.push(seg.take()), now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, ...extra });
    return { seg, flushed };
  };

  it('quiet frames before speech fill a lead-in, prepended when speech starts; speechMs excludes it', () => {
    const time = fakeTime(); const { seg, flushed } = make(time);
    for (let i = 0; i < 5; i++) seg.push(QUIET);                       // ring keeps the last 3
    assert.strictEqual(seg.speaking, false); assert.strictEqual(seg.buffered, 0);
    seg.push(LOUD); seg.push(LOUD); seg.push(QUIET);
    assert.strictEqual(seg.speaking, true); assert.strictEqual(seg.speechStartedAt, 1000);
    time.advance(1000);                                                // silence timer
    assert.strictEqual(flushed.length, 1);
    const u = flushed[0];
    assert.strictEqual(u.durationMs, 6 * 20); assert.strictEqual(u.speechMs, 3 * 20);
    assert.strictEqual(u.pcm.length, 6 * 1920); assert.strictEqual(seg.speaking, false);
  });

  it('each loud frame restarts the silence timer; quiet frames do not', () => {
    const time = fakeTime(); const { seg, flushed } = make(time);
    seg.push(LOUD); time.advance(900); seg.push(LOUD); time.advance(900);
    assert.strictEqual(flushed.length, 0, 'restarted');
    seg.push(QUIET); time.advance(100);
    assert.strictEqual(flushed.length, 1, 'quiet frame did not restart it');
  });

  it('keeps at most maxFrames (the oldest go)', () => {
    const time = fakeTime(); const { seg } = make(time, { maxFrames: 4 });
    for (let i = 0; i < 10; i++) seg.push(LOUD);
    assert.strictEqual(seg.buffered, 4);
  });

  it('keepLast trims to the newest frames and drops the lead-in credit; abandon clears everything', () => {
    const time = fakeTime(); const { seg } = make(time);
    seg.push(QUIET); seg.push(LOUD); for (let i = 0; i < 9; i++) seg.push(LOUD);
    seg.keepLast(4); const u = seg.take();
    assert.strictEqual(u.durationMs, 80); assert.strictEqual(u.speechMs, 80, 'lead-in no longer counted');
    seg.push(LOUD); seg.abandon();
    assert.strictEqual(seg.speaking, false); assert.strictEqual(seg.buffered, 0);
  });

  it('stopSilenceTimer / close cancel a pending silence flush', () => {
    const time = fakeTime(); const { seg, flushed } = make(time);
    seg.push(LOUD); seg.stopSilenceTimer(); time.advance(5000);
    assert.strictEqual(flushed.length, 0);
  });
});

describe('decideWake', () => {
  const base = { speechStartedAt: 10000, now: 13000, durationMs: 3000, peak: 0.001, graceMs: 2000, candidateThreshold: 0.1 };
  const cases = [
    ['detection during the utterance', { wakeAt: 11000 }, 'detected'],
    ['detection up to graceMs before speech began', { wakeAt: 8000 }, 'detected'],
    ['detection longer before than graceMs', { wakeAt: 7999 }, 'discard'],
    ['stale detection (older than the span plus grace)', { wakeAt: 8000, speechStartedAt: 12000, durationMs: 500, now: 15000 }, 'discard'],
    ['span uses the clock when buffered audio lags it', { wakeAt: 9000, durationMs: 500, now: 16000 }, 'detected'],
    ['no detection, peak at the candidate threshold', { wakeAt: 0, peak: 0.1 }, 'candidate'],
    ['no detection, run-on "hey Luna" peak', { wakeAt: 0, peak: 0.41 }, 'candidate'],
    ['no detection, chat-level peak', { wakeAt: 0, peak: 0.002 }, 'discard'],
    ['candidates turned off (threshold 0)', { wakeAt: 0, peak: 0.9, candidateThreshold: 0 }, 'discard'],
  ];
  for (const [name, over, expected] of cases) {
    it(`${name} → ${expected}`, () => assert.strictEqual(v.decideWake({ ...base, ...over }).verdict, expected));
  }
});

describe('decideUtteranceEnd', () => {
  const at = { wakeAt: 10000, listenMs: 4000 };
  it('quiet right after "hey Luna" → listen for the question', () => {
    assert.strictEqual(v.decideUtteranceEnd({ ...at, lastSpeechAt: 10100, quietMs: 1000 }), 'listen');
    assert.strictEqual(v.decideUtteranceEnd({ ...at, lastSpeechAt: 9800, quietMs: 3900 }), 'listen');
  });
  it('the question was spoken after the wake word → end', () => {
    assert.strictEqual(v.decideUtteranceEnd({ ...at, lastSpeechAt: 10400, quietMs: 1000 }), 'end');
  });
  it('waited listenMs and nothing came → end (answered as a greeting)', () => {
    assert.strictEqual(v.decideUtteranceEnd({ ...at, lastSpeechAt: 10100, quietMs: 4000 }), 'end');
  });
  it('no wake word, or WAKE_LISTEN_MS=0 → end', () => {
    assert.strictEqual(v.decideUtteranceEnd({ wakeAt: 0, listenMs: 4000, lastSpeechAt: 100, quietMs: 1000 }), 'end');
    assert.strictEqual(v.decideUtteranceEnd({ ...at, listenMs: 0, lastSpeechAt: 10100, quietMs: 1000 }), 'end');
  });
});

describe('confirmWake', () => {
  const cases = [
    ['detected: leading wake phrase removed', 'Hey Luna, what is the weather?', { detected: true }, 'what is the weather?'],
    ['detected: transcript without it is kept as is', 'what is the weather', { detected: true }, 'what is the weather'],
    ['detected: a bare "hey Luna" stays, answered as a greeting', 'Hey Luna.', { detected: true }, 'Hey Luna.'],
    ['detected mid-sentence: only what follows "hey Luna"', 'Gemma, Gemma. Hey Luna, what are some popular songs?', { detected: true }, 'what are some popular songs?'],
    ['detected: "luna" inside the question is not a wake phrase', 'what does luna mean in Spanish', { detected: true }, 'what does luna mean in Spanish'],
    ['detected: mid-sentence "hey Luna" with nothing after → whole transcript', 'So I said hey Luna.', { detected: true }, 'So I said hey Luna.'],
    ['candidate: the question after a mid-sentence wake phrase', "So anyway, hey Luna, what's the weather?", { candidate: true }, "what's the weather?"],
    ['candidate: Whisper spelling "Loona"', 'Hey Loona what time is it', { candidate: true }, 'what time is it'],
    ['no model: transcript starting with the phrase', 'hey luna tell me a joke', {}, 'tell me a joke'],
  ];
  for (const [name, transcript, how, query] of cases) {
    it(name, () => assert.deepStrictEqual(v.confirmWake(transcript, how), { accepted: true, query }));
  }
  it('candidate without "Luna" ("lunar" does not count) → rejected', () => {
    assert.deepStrictEqual(v.confirmWake('I saw the lunar eclipse', { candidate: true }), { accepted: false, reason: 'no "Luna" in the transcript' });
  });
  it('no model, phrase not at the start → rejected', () => {
    assert.strictEqual(v.confirmWake('tell me a joke luna', {}).accepted, false);
  });
  it('isBareWake: nothing but the wake phrase', () => {
    for (const t of ['Hey Luna.', 'hey luna', 'Luna?', 'Hi, Loona!']) assert.strictEqual(v.isBareWake(t), true, t);
    for (const t of ["Hey Luna, what's up?", 'what is the weather', 'Lunar eclipse.', '']) assert.strictEqual(v.isBareWake(t), false, t);
  });
  it('stripWakeWord leaves "lunar" alone', () => assert.strictEqual(v.stripWakeWord('lunar eclipse tonight'), 'lunar eclipse tonight'));
});

describe('decideSilentSpeaker', () => {
  const gap = { gapMs: 300000 };
  it('audio decrypting fine → restart just their capture, even right after a reconnect', () => {
    assert.strictEqual(v.decideSilentSpeaker({ verdict: { problem: false, ok: 661 }, now: 1000, lastReconnectAt: 900, ...gap }), 'restart-capture');
  });
  it('encryption problem → reconnect, at most once per gap', () => {
    const verdict = { problem: true, ok: 0 };
    assert.strictEqual(v.decideSilentSpeaker({ verdict, now: 400000, lastReconnectAt: 0, ...gap }), 'reconnect');
    assert.strictEqual(v.decideSilentSpeaker({ verdict, now: 400000, lastReconnectAt: 200000, ...gap }), 'wait');
  });
  it('no encryption details (unencrypted, or unavailable) → reconnect/wait as before', () => {
    assert.strictEqual(v.decideSilentSpeaker({ verdict: null, now: 400000, lastReconnectAt: 0, ...gap }), 'reconnect');
    assert.strictEqual(v.decideSilentSpeaker({ verdict: { problem: false, ok: 0 }, now: 1000, lastReconnectAt: 900, ...gap }), 'wait');
  });
});
