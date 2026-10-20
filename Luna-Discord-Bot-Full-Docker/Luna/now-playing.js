// ─── Now playing ──────────────────────────────────────────────────────────────
//
// What smakbot is playing, from its /now-playing endpoint (MUSIC_STATUS_URL;
// smakbot's StatusApiPort). Used two ways:
//   - "what song is this?" is answered from it directly (commands.js routes
//     it, voice-answer.js and text-chat.js say it);
//   - while a song plays, one line in the system prompt names it, so "what's
//     this song about?" or "when did it come out?" need no tool call.
//
// createNowPlaying({ config, fetch, console }) → { enabled, get(guildId), describe(np), promptLine(np) }.
// get() resolves to smakbot's answer ({ playing, paused, title, artist, … })
// or null when there is no URL, smakbot is down or slow — never throws. It is
// asked on every question, so a short timeout and a moment's cache keep it
// off the answer's critical path.

const TIMEOUT_MS = 800;
const CACHE_MS   = 2000;

// "Seal - Crazy (Official Music Video) [HD]" → "Seal - Crazy": the decorations
// YouTube titles carry, which read badly aloud.
const DECORATION = /\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|explicit|clean)\b[^)\]]*)[)\]]/gi;
const cleanTitle = title => String(title || '').replace(DECORATION, '').replace(/\s+/g, ' ').trim();

// "Crazy by Seal" when smakbot knows the track and artist, else the title.
function songName(np) {
  if (np.track && np.artist) return `${np.track} by ${np.artist}`;
  return cleanTitle(np.title) || 'an unnamed song';
}

// 73 → "1:13".
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function createNowPlaying({ config, fetch, console }) {
  const STATUS_URL = config.MUSIC_STATUS_URL;
  let cached = null;   // { at, guildId, value }
  let warnedAt = 0;

  async function get(guildId = '') {
    if (!STATUS_URL) return null;
    if (cached && cached.guildId === guildId && Date.now() - cached.at < CACHE_MS) return cached.value;
    let value = null;
    try {
      const url = guildId ? `${STATUS_URL}${STATUS_URL.includes('?') ? '&' : '?'}guild=${encodeURIComponent(guildId)}` : STATUS_URL;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) value = await res.json();
    } catch (err) {
      // smakbot down or restarting: say so now and then, not on every question.
      if (Date.now() - warnedAt > 10 * 60000) {
        warnedAt = Date.now();
        console.warn(`[music] can't reach smakbot's now-playing (${err.message}) — answering without it`);
      }
    }
    cached = { at: Date.now(), guildId, value };
    return value;
  }

  // The spoken/typed answer to "what song is this?".
  function describe(np) {
    if (!np) return "I can't tell what's playing right now — I can't reach the music bot.";
    if (!np.playing) return "Nothing's playing right now.";
    let text = `${np.paused ? "It's paused on" : 'This is'} ${songName(np)}`;
    if (np.requested_by) text += `, requested by ${np.requested_by}`;
    text += '.';
    if (np.up_next?.length) text += ` Up next: ${cleanTitle(np.up_next[0])}.`;
    return text;
  }

  // For the system prompt, while something plays ('' otherwise).
  function promptLine(np) {
    if (!np?.playing) return '';
    const parts = [`"${cleanTitle(np.title)}"`];
    if (np.artist) parts.push(`artist: ${np.artist}`);
    if (np.track) parts.push(`track: ${np.track}`);
    if (!np.artist && np.uploader) parts.push(`uploaded by ${np.uploader}`);
    let line = `Music ${np.paused ? 'paused' : 'playing'} in the voice channel now: ${parts.join(', ')}`;
    if (np.requested_by) line += `, requested by ${np.requested_by}`;
    if (np.duration) line += ` (${clock(np.elapsed || 0)} of ${clock(np.duration)})`;
    return line + '. When someone asks about "this song" or "the song", they mean this one.';
  }

  return { enabled: !!STATUS_URL, get, describe, promptLine };
}

module.exports = { createNowPlaying, cleanTitle, songName };
