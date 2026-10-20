// ─── Whisper ──────────────────────────────────────────────────────────────────
//
// Speech to text: an utterance's PCM (48 kHz mono, 16-bit) sent as a WAV to
// whisper.cpp's server, round-robin over WHISPER_SERVER_URLS. → the text, or
// null (nothing heard, server error or timeout — logged).
//
// createWhisper({ config, fetch, console }) → { transcribe(pcm) }. fetch and
// console are passed in so the test harness can fake them.

function buildWavBuffer(pcmData, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1,  20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

function createWhisper({ config, fetch, console }) {
  const URLS = config.WHISPER_SERVER_URLS;
  let next = 0;
  const nextUrl = () => URLS[next++ % URLS.length];

  // Without a timeout a hung Whisper call never settles, the speaker's
  // `flushing` stays true forever, and they go permanently deaf with nothing
  // logged. Generous, because a saturated CPU makes Whisper genuinely slow —
  // this is for hangs, not slowness.
  const WHISPER_TIMEOUT_MS = config.WHISPER_TIMEOUT_MS;

  async function transcribe(pcm) {
    const wavBuffer = buildWavBuffer(pcm, 48000, 1, 16);
    try {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'json');

      const res = await fetch(nextUrl(), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`Whisper server error ${res.status}:`, await res.text());
        return null;
      }
      const data = await res.json();
      return (data.text || '').trim() || null;
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.error(`Whisper timed out after ${WHISPER_TIMEOUT_MS}ms — server may be overloaded`);
      } else {
        console.error('Whisper server error:', err.message);
      }
      return null;
    }
  }

  return { transcribe };
}

module.exports = { createWhisper, buildWavBuffer };
