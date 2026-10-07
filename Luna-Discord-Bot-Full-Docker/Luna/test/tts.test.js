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
global.fetch = async (url, init) => {
  const who = url.includes('kokoro') ? 'kokoro' : url.includes('qwen') ? 'qw' : url.includes('chatterbox') ? 'cb' : 'el';
  const sent = JSON.parse(init.body); calls.push({ who, url, voice: sent.voice, stream: sent.stream, text: sent.text ?? sent.input, model: sent.model_id, key: init.headers['xi-api-key'] });
  const r = script[who].length > 1 ? script[who].shift() : script[who][0];
  if (r === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  if (r === 'neterr') throw new TypeError('fetch failed');
  return r();
};
const read = async s => { let out = ''; for await (const c of s) out += Buffer.from(c).toString(); return out; };
function load(env, s = {}) {
  for (const k of Object.keys(process.env)) if (/^(TTS_|ELEVENLABS_|KOKORO_|QWEN3_|CHATTERBOX_)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  calls = []; logs = []; script = { kokoro: [res(200, '', 'KOKORO-AUDIO')], el: [res(200, '', 'EL-AUDIO')], qw: [res(200, '', 'QW-AUDIO')], cb: [res(200, '', 'CB-AUDIO')], ...s };
  console.error = console.warn = console.log = (...a) => logs.push(a.join(' '));
  delete require.cache[require.resolve(require('path').join(__dirname, '..', 'tts.js'))];
  return require(require('path').join(__dirname, '..', 'tts.js'));
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
      ['429 concurrent_limit_exceeded', res(429, { detail: { code: 'concurrent_limit_exceeded' } }), false],
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
  real('ALL PASS');
  clearInterval(keepAlive);
})().catch(e => { realErr('FAIL:', e.stack); process.exit(1); });
