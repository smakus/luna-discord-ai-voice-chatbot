// TTS providers and fallback chain (tts.js), with fetch faked.
// Run: node --test test/   (see README → Development)
const assert = require('assert');
const ok = m => console.log('  ✓ ' + m);
const BASE = { KOKORO_URL: 'http://kokoro/v1/audio/speech', KOKORO_VOICE: 'af_heart' };
const EL = { ...BASE, TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v1' };

let calls, logs, script;
const body = s => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
const res = (status, payload, audio) => () => ({ ok: status < 300, status,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload), body: body(audio || '') });
const fakeFetch = async (url, init) => {
  const who = url.includes('kokoro') ? 'kokoro' : url.includes('qwen') ? 'qw' : url.includes('chatterbox') ? 'cb' : 'el';
  const sent = JSON.parse(init.body); calls.push({ who, url, voice: sent.voice, stream: sent.stream, text: sent.text ?? sent.input, model: sent.model_id, key: init.headers['xi-api-key'] });
  const r = script[who].length > 1 ? script[who].shift() : script[who][0];
  if (r === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  if (r === 'neterr') throw new TypeError('fetch failed');
  return r();
};
const read = async s => { let out = ''; for await (const c of s) out += Buffer.from(c).toString(); return out; };
const { createTTS, stripAudioTags, createLimiter } = require('../tts');
const { loadConfig } = require('../config');
// With `fs`, the phrase cache works (in a temporary folder: env.TTS_CACHE_DIR).
function load(env, s = {}, fs = null) {
  calls = []; logs = []; script = { kokoro: [res(200, '', 'KOKORO-AUDIO')], el: [res(200, '', 'EL-AUDIO')], qw: [res(200, '', 'QW-AUDIO')], cb: [res(200, '', 'CB-AUDIO')], ...s };
  const record = (...a) => logs.push(a.join(' '));
  const tts = createTTS({ config: loadConfig(env), fetch: fakeFetch, console: { log: record, warn: record, error: record }, fs });
  return { ...tts, stripAudioTags, createLimiter };
}
const real = console.log, realErr = console.error;
const say = m => real('  ✓ ' + m);
const wait = ms => new Promise(r => setTimeout(r, ms));

// Luna's Discord client keeps the process alive; AbortSignal.timeout timers
// are unref'd and would not, so stand in for it here.
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  real('defaults');
  let t = load(BASE);
  assert.strictEqual(t.describeTTS(), 'Kokoro'); assert.strictEqual(t.expressivePrompt(), '');
  assert.strictEqual(await read(await t.fetchTTS('Hi [laughs] there.')), 'KOKORO-AUDIO');
  assert.strictEqual(calls[0].text, 'Hi there.'); say('no TTS_PROVIDER → Kokoro only, no expressive prompt, tags stripped');

  real('ElevenLabs happy path');
  t = load(EL);
  assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive');
  assert.ok(t.expressivePrompt().includes('[laughs]'));
  assert.strictEqual(await read(await t.fetchTTS('[laughs] That is great.')), 'EL-AUDIO');
  const c = calls[0];
  assert.strictEqual(c.url, 'https://api.elevenlabs.io/v1/text-to-speech/v1/stream?output_format=mp3_44100_128');
  assert.deepStrictEqual([c.text, c.model, c.key], ['[laughs] That is great.', 'eleven_v4_turbo', 'k']);
  say('v4 Turbo by default, tags passed through, stream endpoint + mp3, expressive prompt on');

  real('out of credits');
  for (const [label, r] of [['402 insufficient_credits', res(402, { detail: { code: 'insufficient_credits', message: 'Your account does not have enough credits' } })],
                            ['legacy 401 quota_exceeded', res(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } })]]) {
    t = load({ ...EL, TTS_CREDITS_RETRY_MS: '150' }, { el: [r, r, r, res(200, '', 'EL-AUDIO')] });
    const streams = await Promise.all([t.fetchTTS('[sighs] One.'), t.fetchTTS('Two.'), t.fetchTTS('Three.')]);
    assert.deepStrictEqual(await Promise.all(streams.map(read)), ['KOKORO-AUDIO', 'KOKORO-AUDIO', 'KOKORO-AUDIO']);
    assert.strictEqual(calls.find(x => x.who === 'kokoro' && x.text.includes('One')).text, 'One.');
    assert.strictEqual(logs.filter(l => /for the next/.test(l)).length, 1, 'logged once');
    assert.strictEqual(t.expressivePrompt(), '');
    const before = calls.filter(x => x.who === 'el').length;
    await t.fetchTTS('Four.'); assert.strictEqual(calls.filter(x => x.who === 'el').length, before);
    say(`${label}: all prefetched sentences → Kokoro (tags stripped), logged once, ElevenLabs skipped, expressive prompt off`);
    await wait(170);
    assert.strictEqual(await read(await t.fetchTTS('Five.')), 'EL-AUDIO');
    assert.ok(logs.some(l => /working again/.test(l))); assert.ok(t.expressivePrompt());
    say('  …after TTS_CREDITS_RETRY_MS, ElevenLabs is retried and back in use');
  }


  real('credits vs other errors: pause length');
  for (const [label, r, expect] of [
    ['402 insufficient_credits', res(402, { detail: { code: 'insufficient_credits', message: 'Your account does not have enough credits' } }), /out of credits; using Kokoro for the next 12 h/],
    ['legacy 401 quota_exceeded (seen live)', res(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000. You have 21 credits remaining, while 24 credits are required for this request.' } }), /out of credits; using Kokoro for the next 12 h/],
    ['401 invalid_api_key', res(401, { detail: { code: 'invalid_api_key', message: 'bad key' } }), /— using Kokoro for the next 30 min/],
    ['402 paid_plan_required (library voice on free plan)', res(402, { detail: { type: 'payment_required', code: 'paid_plan_required', status: 'payment_required', message: 'Free users cannot use library voices via the API.' } }), /— using Kokoro for the next 30 min/],
  ]) {
    t = load(EL, { el: [r] }); await t.fetchTTS('A.');
    assert.ok(logs.some(l => expect.test(l)), label + ': ' + logs.join(' | '));
    say(`${label} → ${expect.source.includes('12 h') ? '12 h pause' : '30 min pause'}`);
  }
  { t = load(EL, { el: [res(401, { detail: { status: 'quota_exceeded', message: 'quota' } }), res(200, '', 'EL-AUDIO')] });
    await t.fetchTTS('A.'); const before = calls.filter(x => x.who === 'el').length;
    for (let k = 0; k < 5; k++) await t.fetchTTS('Short.');
    assert.strictEqual(calls.filter(x => x.who === 'el').length, before);
    say('during the credits pause, even short lines stay on Kokoro (no flip-flopping)'); }

  real('other ElevenLabs failures');
  for (const [label, r, benched] of [['401 invalid_api_key', res(401, { detail: { code: 'invalid_api_key', message: 'bad key' } }), true],
      ['404 voice_not_found', res(404, { detail: { code: 'voice_not_found' } }), true],
      ['429 rate limit', res(429, { detail: { code: 'rate_limit_exceeded' } }), false],
      ['503 service_unavailable', res(503, 'oops'), false],
      ['network error', 'neterr', false]]) {
    t = load(EL, { el: [r, res(200, '', 'EL-AUDIO')] });
    assert.strictEqual(await read(await t.fetchTTS('A.')), 'KOKORO-AUDIO');
    assert.strictEqual(await read(await t.fetchTTS('B.')), benched ? 'KOKORO-AUDIO' : 'EL-AUDIO');
    say(`${label} → Kokoro for this sentence; ${benched ? 'ElevenLabs benched' : 'next sentence tries ElevenLabs again'}`);
  }
  t = load({ ...EL, ELEVENLABS_TIMEOUT_MS: '50' }, { el: ['hang', res(200, '', 'EL-AUDIO')] });
  const t0 = Date.now(); assert.strictEqual(await read(await t.fetchTTS('A.')), 'KOKORO-AUDIO');
  assert.ok(Date.now() - t0 < 1000); assert.ok(logs.some(l => /timed out after 50ms/.test(l)));
  say('timeout → Kokoro within ELEVENLABS_TIMEOUT_MS');

  real('configuration edge cases');
  t = load({ ...BASE, TTS_PROVIDER: 'elevenlabs' });
  assert.strictEqual(t.describeTTS(), 'Kokoro'); assert.ok(logs.some(l => /not configured/.test(l))); say('elevenlabs without key/voice → Kokoro + warning');
  t = load({ ...BASE, TTS_PROVIDER: 'polly' }); assert.strictEqual(t.describeTTS(), 'Kokoro'); say('unknown provider → Kokoro + warning');
  t = load({ ...EL, TTS_FALLBACK: 'none' }, { el: [res(402, { detail: { code: 'insufficient_credits' } })] });
  assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo), expressive');
  assert.strictEqual(await t.fetchTTS('A.'), null); assert.strictEqual(calls.filter(x => x.who === 'kokoro').length, 0);
  assert.strictEqual(await t.fetchTTS('B.'), null); assert.strictEqual(calls.length, 2); say('TTS_FALLBACK=none → no Kokoro; sole provider still retried rather than silenced');
  t = load({ ...EL, ELEVENLABS_MODEL: 'eleven_flash_v2_5' });
  assert.strictEqual(t.expressivePrompt(), ''); await t.fetchTTS('[laughs] Hi.'); assert.strictEqual(calls[0].text, 'Hi.');
  say('non-tag model (flash) → no expressive prompt, tags stripped');
  t = load({ ...EL, TTS_EXPRESSIVE: 'false' }); assert.strictEqual(t.expressivePrompt(), '');
  await t.fetchTTS('[laughs] Hi.'); assert.strictEqual(calls[0].text, 'Hi.'); say('TTS_EXPRESSIVE=false → no prompt, tags stripped');
  t = load(BASE); assert.strictEqual(await t.fetchTTS('[laughs]'), null); assert.strictEqual(calls.length, 0); say('tag-only sentence on Kokoro → skipped, no request');
  t = load(BASE, { kokoro: [res(500, 'boom')] }); assert.strictEqual(await t.fetchTTS('A.'), null); say('Kokoro failure with nothing left → null (sentence skipped, as before)');


  real('cancellation');
  t = load(EL); const pre = new AbortController(); pre.abort();
  assert.strictEqual(await t.fetchTTS('A.', { signal: pre.signal }), null); assert.strictEqual(calls.length, 0); say('already-aborted signal → null, no request');
  t = load(EL, { el: ['hang'] }); const ac = new AbortController();
  const pending = t.fetchTTS('A.', { signal: ac.signal }); await wait(20); ac.abort();
  assert.strictEqual(await pending, null); assert.strictEqual(calls.filter(x => x.who === 'kokoro').length, 0);
  assert.ok(!logs.some(l => /\[tts\]/.test(l)), 'no error logged'); say('abort mid-request → null, no Kokoro fallback, nothing logged');
  let cancelled = false;
  t = load(BASE, { kokoro: [() => ({ ok: true, status: 200, text: async () => '', body: new ReadableStream({
    pull(c) { return new Promise(r => setTimeout(() => { if (!cancelled) c.enqueue(new Uint8Array(10)); r(); }, 20)); }, cancel() { cancelled = true; } }) })] });
  const st = await t.fetchTTS('Long.'); await wait(50); st.destroy(); await wait(50);
  assert.ok(cancelled); say('destroying a returned stream cancels the download');

  real('Qwen3-TTS');
  const QW = { ...BASE, QWEN3_TTS_URL: 'http://qwen3/v1/audio/speech' };
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', QWEN3_TTS_VOICE: 'luna' });
  assert.strictEqual(t.describeTTS(), 'Qwen3-TTS → fallback Kokoro'); assert.strictEqual(t.expressivePrompt(), '');
  assert.strictEqual(await read(await t.fetchTTS('Hi [laughs] there.')), 'QW-AUDIO');
  assert.deepStrictEqual([calls[0].text, calls[0].voice, calls[0].stream], ['Hi there.', 'luna', false]);
  say('TTS_PROVIDER=qwen3 → Qwen3-TTS then Kokoro, buffered (stream:false) by default, tags stripped, no expressive prompt');
  await t.fetchTTS('Next.'); assert.strictEqual(calls.find(x => x.who === 'kokoro'), undefined); say('Kokoro still streams (unaffected)') ;
  t = load({ ...QW, TTS_PROVIDER: 'kokoro' }); await t.fetchTTS('A.'); assert.strictEqual(calls[0].stream, true); say('Kokoro requests stream:true');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', QWEN3_TTS_STREAM: 'true' }); await t.fetchTTS('A.'); assert.strictEqual(calls[0].stream, true); say('QWEN3_TTS_STREAM=true → streamed');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3' }); await t.fetchTTS('A.'); assert.strictEqual(calls[0].voice, undefined); say('no QWEN3_TTS_VOICE → voice omitted, server default');
  t = load({ ...BASE, TTS_PROVIDER: 'qwen3' });
  assert.strictEqual(t.describeTTS(), 'Kokoro'); assert.ok(logs.some(l => /Qwen3-TTS selected but not configured/.test(l))); say('qwen3 without QWEN3_TTS_URL → Kokoro + warning');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3' }, { qw: ['neterr', res(200, '', 'QW-AUDIO')] });
  assert.strictEqual(await read(await t.fetchTTS('A.')), 'KOKORO-AUDIO'); assert.ok(logs.some(l => /falling back to Kokoro/.test(l)));
  assert.strictEqual(await read(await t.fetchTTS('B.')), 'QW-AUDIO'); say('server not running → that sentence to Kokoro, next tries Qwen3-TTS again');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', TTS_PROVIDER_RETRY_MS: '100000' }, { qw: [res(400, { detail: "unknown voice 'bob'; installed: luna" })] });
  await t.fetchTTS('A.'); await t.fetchTTS('B.');
  assert.strictEqual(calls.filter(x => x.who === 'qw').length, 1); assert.ok(logs.some(l => /unknown voice.*using Kokoro for the next 2 min/.test(l)), logs.join(' | '));
  say('unknown voice → benched for TTS_PROVIDER_RETRY_MS, Kokoro meanwhile');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3' }, { qw: [res(503, { detail: 'model failed to load' }), res(200, '', 'QW-AUDIO')] });
  await t.fetchTTS('A.'); assert.strictEqual(await read(await t.fetchTTS('B.')), 'QW-AUDIO'); say('503 → transient, retried next sentence');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', QWEN3_TTS_TIMEOUT_MS: '50' }, { qw: ['hang'] });
  const t1 = Date.now(); assert.strictEqual(await read(await t.fetchTTS('A.')), 'KOKORO-AUDIO'); assert.ok(Date.now() - t1 < 1000);
  assert.ok(logs.some(l => /Qwen3-TTS timed out after 50ms/.test(l))); say('QWEN3_TTS_TIMEOUT_MS → Kokoro');

  real('Chatterbox');
  const CB = { ...BASE, CHATTERBOX_URL: 'http://chatterbox/v1/audio/speech' };
  t = load({ ...CB, TTS_PROVIDER: 'chatterbox' });
  assert.strictEqual(t.describeTTS(), 'Chatterbox → fallback Kokoro, expressive');
  for (const tag of ['[happy]', '[sarcastic]', '[surprised]', '[whispering]', '[angry]', '[fear]', '[crying]', '[dramatic]',
    '[laugh]', '[chuckle]', '[sigh]', '[gasp]', '[groan]', '[sniff]', '[cough]', '[clear throat]', '[shush]']) {
    assert.ok(t.expressivePrompt().includes(tag), tag);
  }
  assert.ok(!/\[advertisement\]|\[narration\]/.test(t.expressivePrompt()));
  say('TTS_PROVIDER=chatterbox → expressive; the prompt names every emotion and sound tag it performs');
  assert.strictEqual(await read(await t.fetchTTS('[sigh] Oh no. [laughs] Kidding! [Happy] Yay [low voice] [clear throat] ok.')), 'CB-AUDIO');
  assert.deepStrictEqual([calls[0].text, calls[0].voice, calls[0].stream], ['[sigh] Oh no. [laugh] Kidding! [happy] Yay [clear throat] ok.', undefined, false]);
  say('known tags kept, ElevenLabs spellings mapped ([laughs] → [laugh]), case folded, unknown tags dropped; buffered, server\'s default voice');
  await t.fetchTTS('[laugh]'); assert.strictEqual(calls[1].text, '[laugh]'); say('a sentence that is only a sound is still performed');
  t = load({ ...CB, TTS_PROVIDER: 'chatterbox', CHATTERBOX_VOICE: 'default', CHATTERBOX_STREAM: 'true' }); await t.fetchTTS('A.');
  assert.deepStrictEqual([calls[0].voice, calls[0].stream], ['default', true]); say('CHATTERBOX_VOICE / CHATTERBOX_STREAM');
  t = load({ ...CB, TTS_PROVIDER: 'chatterbox', TTS_EXPRESSIVE: 'false' });
  assert.strictEqual(t.expressivePrompt(), ''); await t.fetchTTS('[laugh] Hi.'); assert.strictEqual(calls[0].text, 'Hi.'); say('TTS_EXPRESSIVE=false → no prompt, tags stripped');
  t = load({ ...CB, TTS_PROVIDER: 'chatterbox', TTS_EXPRESSIVE_PROMPT: 'Custom.' }); assert.strictEqual(t.expressivePrompt(), 'Custom.'); say('TTS_EXPRESSIVE_PROMPT replaces the wording');
  t = load({ ...CB, TTS_PROVIDER: 'chatterbox' }, { cb: ['neterr', res(200, '', 'CB-AUDIO')] });
  assert.strictEqual(await read(await t.fetchTTS('[laugh] A.')), 'KOKORO-AUDIO'); assert.strictEqual(calls[1].text, 'A.');
  say('server down → that sentence to Kokoro, tags stripped there');
  t = load({ ...EL, ...CB, TTS_FALLBACK: 'chatterbox' }, { el: [res(402, { detail: { code: 'insufficient_credits' } })] });
  await t.fetchTTS('[whispers] Psst.'); assert.strictEqual(calls.find(x => x.who === 'cb').text, '[whispering] Psst.');
  assert.ok(t.expressivePrompt().includes('[clear throat]')); say('ElevenLabs out of credits → Chatterbox: its own tag prompt, ElevenLabs tags mapped');
  t = load({ ...BASE, TTS_PROVIDER: 'chatterbox' }); assert.ok(logs.some(l => /Chatterbox selected but not configured/.test(l))); say('no CHATTERBOX_URL → Kokoro + warning');

  real('three-provider chain');
  t = load({ ...EL, ...QW, TTS_FALLBACK: 'qwen3' }, { el: [res(402, { detail: { code: 'insufficient_credits' } })] });
  assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo) → fallback Qwen3-TTS → fallback Kokoro, expressive');
  assert.strictEqual(await read(await t.fetchTTS('[laughs] One.')), 'QW-AUDIO');
  assert.ok(logs.some(l => /out of credits; using Qwen3-TTS for the next 12 h/.test(l))); assert.strictEqual(calls.find(x => x.who === 'qw').text, 'One.');
  assert.strictEqual(t.expressivePrompt(), ''); say('ElevenLabs out of credits → Qwen3-TTS (tags stripped, tag prompt off)');
  t = load({ ...EL, ...QW, TTS_FALLBACK: 'qwen3' }, { el: [res(500, 'x')], qw: ['neterr'] });
  assert.strictEqual(await read(await t.fetchTTS('A.')), 'KOKORO-AUDIO');
  assert.deepStrictEqual(calls.map(x => x.who), ['el', 'qw', 'kokoro']); say('ElevenLabs error + Qwen3-TTS down → Kokoro');
  t = load({ ...EL, ...QW, TTS_FALLBACK: 'qwen3', TTS_PROVIDER_RETRY_MS: '100000' }, { el: [res(401, { detail: { code: 'invalid_api_key' } })], qw: [res(400, 'unknown voice x')] });
  await t.fetchTTS('A.'); calls = []; assert.strictEqual(await read(await t.fetchTTS('B.')), 'KOKORO-AUDIO');
  assert.deepStrictEqual(calls.map(x => x.who), ['kokoro']); say('both benched → straight to Kokoro');
  t = load({ ...EL, ...QW }); assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive'); say('QWEN3_TTS_URL set but not chosen → unused (compose always sets it)');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', TTS_FALLBACK: 'kokoro' }); assert.strictEqual(t.describeTTS(), 'Qwen3-TTS → fallback Kokoro'); say('no duplicate Kokoro');
  t = load({ ...QW, TTS_PROVIDER: 'qwen3', TTS_FALLBACK: 'none' }); assert.strictEqual(t.describeTTS(), 'Qwen3-TTS'); say('TTS_FALLBACK=none → Qwen3-TTS only');
  t = load({ ...EL, TTS_FALLBACK: 'qwen3' }); assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive'); say('fallback qwen3 without URL → skipped');
  t = load({ ...EL, TTS_FALLBACK: 'polly' }); assert.strictEqual(t.describeTTS(), 'ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive');
  assert.ok(logs.some(l => /unknown TTS_FALLBACK "polly"/.test(l))); say('unknown TTS_FALLBACK → warning, Kokoro');

  real('stripAudioTags');
  t = load(BASE);
  for (const [i, o] of [['[laughs] Hi.', 'Hi.'], ['Wait [whispers] here.', 'Wait here.'], ['[low, gravelly voice] Ok.', 'Ok.'], ['No tags.', 'No tags.'], ['Array [1, 2] stays?', 'Array stays?']])
    assert.strictEqual(t.stripAudioTags(i), o, i);
  say('5 cases');
  real('ElevenLabs concurrency limit');
  t = load(BASE);
  { const lim = t.createLimiter(2, 'X'); const r1 = await lim.acquire(null, 1000), r2 = await lim.acquire(null, 1000);
    let third = null; const p3 = lim.acquire(null, 1000).then(r => { third = r; });
    await wait(20); assert.strictEqual(third, null, 'third waits'); r1(); r1(); await p3; assert.ok(third);
    assert.strictEqual(lim.active, 2, 'double release counted once');
    const c = new AbortController(); const p4 = lim.acquire(c.signal, 1000); c.abort();
    await assert.rejects(p4, e => e.kind === 'cancelled');
    await assert.rejects(lim.acquire(null, 30), e => e.kind === 'transient' && /no free slot after 30ms/.test(e.message));
    say('limiter: waits in turn, release is idempotent, cancel and wait timeout reject'); }
  { let inflight = 0, most = 0;
    const slow = () => { inflight++; most = Math.max(most, inflight);
      return { ok: true, status: 200, text: async () => '', body: new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode('EL-AUDIO')); c.close(); inflight--; }, 120); } }) }; };
    t = load({ ...EL, ELEVENLABS_MAX_CONCURRENCY: '2' }, { el: [slow] });
    const results = await Promise.all(['One.', 'Two.', 'Three.', 'Four.'].map(s => t.fetchTTS(s).then(read)));
    assert.deepStrictEqual(results, ['EL-AUDIO', 'EL-AUDIO', 'EL-AUDIO', 'EL-AUDIO']);
    assert.strictEqual(most, 2, `at most 2 at once (saw ${most})`); assert.ok(!calls.some(c => c.who === 'kokoro'));
    say('4 sentences at once with ELEVENLABS_MAX_CONCURRENCY=2 → never more than 2 in progress, all in the ElevenLabs voice'); }
  { const busy = res(429, { detail: { status: 'concurrent_limit_exceeded', message: 'Too many concurrent requests. Your current subscription is associated with a maximum of 3 concurrent requests' } });
    t = load(EL, { el: [busy, res(200, '', 'EL-AUDIO')] });
    assert.strictEqual(await read(await t.fetchTTS('Hi.')), 'EL-AUDIO');
    assert.deepStrictEqual(calls.map(c => c.who), ['el', 'el']); say('429 "too many concurrent requests" (another client on the key) → retried once, no fallback');
    t = load(EL, { el: [busy, busy] });
    assert.strictEqual(await read(await t.fetchTTS('Hi.')), 'KOKORO-AUDIO'); say('…still busy after the retry → that sentence falls back'); }
  real('a specific ElevenLabs voice (custom greetings)');
  t = load(EL); assert.strictEqual(await read(await t.fetchTTSInVoice('[excited] Hi smakus.', 'VOICE9')), 'EL-AUDIO');
  assert.ok(calls[0].url.includes('/text-to-speech/VOICE9/') && calls[0].text === '[excited] Hi smakus.'); say('requests that voice, tags kept');
  t = load(EL, { el: [res(404, { detail: { code: 'voice_not_found' } })] }); assert.strictEqual(await t.fetchTTSInVoice('Hi.', 'NOPE'), null);
  assert.ok(!calls.some(c => c.who !== 'el'), 'no other voice tried'); say('voice not found → null, no fallback voice (the caller plays its normal line)');
  t = load(BASE); assert.strictEqual(await t.fetchTTSInVoice('Hi.', 'V'), null); assert.strictEqual(calls.length, 0); say('ElevenLabs not configured → null');
  t = load(EL, { el: [res(402, { detail: { code: 'insufficient_credits' } }), res(200, '', 'EL-AUDIO')] }); await t.fetchTTS('One.');
  calls = []; assert.strictEqual(await t.fetchTTSInVoice('Hi.', 'V'), null); assert.strictEqual(calls.length, 0); say('ElevenLabs benched (out of credits) → null, no request');
  real('NAME_PRONUNCIATIONS');
  t = load({ ...BASE, NAME_PRONUNCIATIONS: 'smakus=smack-us|Jo.el=Jo-ell' });
  for (const [i, o] of [['Hey smakus!', 'Hey smack-us!'], ['SMAKUS, welcome back.', 'smack-us, welcome back.'], ["That's Smakus's song.", "That's smack-us's song."],
    ['smakusbot and asmakus stay.', 'smakusbot and asmakus stay.'], ['Hi Jo.el and Joxel.', 'Hi Jo-ell and Joxel.']])
    assert.strictEqual(t.pronounce(i), o, i);
  await t.fetchTTS('Hi smakus.'); assert.strictEqual(calls[0].text, 'Hi smack-us.');
  say('whole words, any capitalisation, regex characters in names taken literally; applied to what the voice gets');
  t = load({ ...BASE, NAME_PRONUNCIATIONS: 'smakus|=x|ok=fine' });
  assert.strictEqual(t.pronounce('ok smakus'), 'fine smakus');
  assert.strictEqual(logs.filter(l => /NAME_PRONUNCIATIONS entry .* ignored/.test(l)).length, 2); say('malformed entries → warned and ignored, the rest still apply');
  real('phrase cache');
  { const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-tts-cache-'));
    const cached = (env, s) => load({ ...env, TTS_CACHE_DIR: dir }, s, fs);
    const settle = () => wait(50);
    t = cached(EL);
    assert.strictEqual(await read(await t.fetchTTS('[curious] Let me look.', { cache: true })), 'EL-AUDIO'); await settle();
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.audio')).length, 1, 'kept once complete');
    calls = [];
    assert.strictEqual(await read(await t.fetchTTS('[curious] Let me look.', { cache: true })), 'EL-AUDIO');
    assert.strictEqual(calls.length, 0, 'the repeat costs nothing');
    say('a cached line: rendered once, then played from disk with no request');
    assert.strictEqual(await read(await t.fetchTTS('Some answer.')), 'EL-AUDIO'); await settle();
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.audio')).length, 1); say('answers (no cache option) are not kept');
    t = cached({ ...EL, ELEVENLABS_VOICE_ID: 'other' }); calls = [];
    await read(await t.fetchTTS('[curious] Let me look.', { cache: true })); assert.strictEqual(calls.length, 1); await settle();
    say('another voice → a miss, rendered afresh');
    t = cached(EL, { el: [res(402, { detail: { code: 'insufficient_credits' } })] }); await t.fetchTTS('Fill the bench.'); calls = [];
    assert.strictEqual(await read(await t.fetchTTS('[curious] Let me look.', { cache: true })), 'EL-AUDIO');
    assert.strictEqual(calls.length, 0); say('ElevenLabs out of credits → a cached line still plays in its voice');
    t = cached(EL); calls = [];
    await read(await t.fetchTTSInVoice('Howdy appa.', 'V9', { cache: true })); await settle();
    assert.strictEqual(await read(await t.fetchTTSInVoice('Howdy appa.', 'V9', { cache: true })), 'EL-AUDIO');
    assert.strictEqual(calls.length, 1); say('custom-voice greetings cached per voice');
    // A line cut off part-way leaves nothing behind.
    const slow = () => ({ ok: true, status: 200, text: async () => '', body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('PART')); } }) });
    t = cached(EL, { el: [slow] }); const before = fs.readdirSync(dir).length;
    const st = await t.fetchTTS('Cut off.', { cache: true }); await wait(20); st.destroy(); await settle();
    assert.strictEqual(fs.readdirSync(dir).length, before); say('a line superseded part-way → nothing kept');
    // Past TTS_CACHE_MAX_MB, the least recently played go.
    const big = () => res(200, '', 'X'.repeat(400 * 1024))();
    t = load({ ...EL, TTS_CACHE_DIR: dir, TTS_CACHE_MAX_MB: '1' }, { el: [big] }, fs);
    for (const line of ['A.', 'B.', 'C.', 'D.']) { await read(await t.fetchTTS(line, { cache: true })); await settle(); }
    const total = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    assert.ok(total <= 1024 * 1024, `kept under the cap (${total})`); calls = [];
    await read(await t.fetchTTS('D.', { cache: true })); assert.strictEqual(calls.length, 0, 'the newest stays');
    say('past TTS_CACHE_MAX_MB → least recently played deleted');
    fs.writeFileSync(path.join(dir, 'a-file'), '');   // a folder inside a file can't be made
    t = load({ ...EL, TTS_CACHE_DIR: path.join(dir, 'a-file', 'cache') }, {}, fs); await read(await t.fetchTTS('Hi.', { cache: true })); await t.fetchTTS('Hi.', { cache: true });
    assert.strictEqual(logs.filter(l => /phrase cache off/.test(l)).length, 1); say("folder can't be used → warned once, lines still play");
    fs.rmSync(dir, { recursive: true, force: true }); }

  real('ALL PASS');
  clearInterval(keepAlive);
})().catch(e => { realErr('FAIL:', e.stack); process.exit(1); });
