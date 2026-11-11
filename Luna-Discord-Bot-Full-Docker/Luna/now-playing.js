// ─── Now playing ──────────────────────────────────────────────────────────────
//
// What smakbot is playing, from its /now-playing endpoint (MUSIC_STATUS_URL;
// smakbot's StatusApiPort). Used two ways:
//   - "what song is this?" is answered from it directly (commands.js routes
//     it, voice-answer.js and text-chat.js say it);
//   - while a song plays, one line in the system prompt names it, so "what's
//     this song about?" or "when did it come out?" need no tool call.
//
// It also reads smakbot's most played list (/top-songs, next to /now-playing):
// "what are our top songs?" (topSongs, describeTop) and the LLM's
// list_top_songs tool (listForModel). And, from the same endpoint with
// ?user=, the songs one person asked for most, online or not: "what are my
// top songs?" (topRequests, describeRequests) and list_top_songs with a
// user (listRequestsForModel).
//
// createNowPlaying({ config, fetch, console }) → { enabled, get(guildId), describe(np), promptLine(np),
//   topSongs(count), describeTop(songs, count), listForModel(songs),
//   topRequests(user, count), describeRequests(result, count), listRequestsForModel(result, said) }.
// get() resolves to smakbot's answer ({ playing, paused, title, artist, … })
// or null when there is no URL, smakbot is down or slow — never throws. It is
// asked on every question, so a short timeout and a moment's cache keep it
// off the answer's critical path.

const TIMEOUT_MS = 800;
const CACHE_MS   = 2000;

// "Seal - Crazy (Official Music Video) [HD]" → "Seal - Crazy": the decorations
// YouTube titles carry, which read badly aloud. Everything after a " | " goes
// too: "One Chain to Rule Them All | Gandalf x Frodo (…) - WeGoTunes Studio".
const DECORATION = /\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|explicit|clean)\b[^)\]]*)[)\]]/gi;
const cleanTitle = title => String(title || '').split(/\s+\|\s+/)[0].replace(DECORATION, '').replace(/\s+/g, ' ').trim();

// "Crazy by Seal" when smakbot knows the track and artist, else the title.
function songName(np) {
  if (np.track && np.artist) return `${np.track} by ${np.artist}`;
  return cleanTitle(np.title) || 'an unnamed song';
}

// 73 → "1:13".
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function createNowPlaying({ config, fetch, console }) {
  const STATUS_URL = config.MUSIC_STATUS_URL;
  // The LLM knows people by their speakable names (NAME_PRONUNCIATIONS:
  // smakus=smackus), so a name it passes is turned back into the real one.
  const squash = name => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const REAL_NAMES = new Map((config.NAME_PRONUNCIATIONS || []).flatMap(entry => {
    const eq = entry.indexOf('=');
    return eq > 0 ? [[squash(entry.slice(eq + 1)), entry.slice(0, eq).trim()]] : [];
  }));
  const realName = said => REAL_NAMES.get(squash(said)) || String(said).trim();
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

  // smakbot's most played songs ([{ title, plays }], most first), or null
  // when there is no URL or smakbot can't be reached. Not cached: asked rarely.
  async function topSongs(count) {
    if (!STATUS_URL) return null;
    try {
      const url = new URL('top-songs', STATUS_URL);
      url.searchParams.set('count', String(count));
      const res = await fetch(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
      if (!res.ok) return null;
      const { songs } = await res.json();
      return Array.isArray(songs) ? songs : null;
    } catch (err) {
      console.warn(`[music] can't reach smakbot's top songs (${err.message})`);
      return null;
    }
  }

  // The spoken/typed answer to "what are our top songs?".
  function describeTop(songs, count) {
    if (!songs) return "I can't check the top songs right now — I can't reach the music bot.";
    if (!songs.length) return "Nothing has been played enough to count yet.";
    const list = songs.slice(0, count).map((s, i) =>
      `${cleanTitle(s.title) || 'an unnamed song'}, ${s.plays}${i === 0 ? ` play${s.plays === 1 ? '' : 's'}` : ''}`);
    const head = list.length === 1 ? 'Your most played song is' : `Your top ${list.length}:`;
    return `${head} ${list.join('. ')}.`;
  }

  // What the LLM's list_top_songs tool answers it.
  function listForModel(songs) {
    if (!songs) return 'The music bot could not be reached, so the most played songs are unknown. Say so.';
    if (!songs.length) return 'No songs have been played enough to count yet.';
    return 'Most played songs in this server, most first:\n' +
      songs.map((s, i) => `${i + 1}. ${cleanTitle(s.title)} (${s.plays} plays)`).join('\n');
  }

  // The songs one person asked for most — user: a Discord user ID or a name,
  // loosely ("smak", "smackus"): smakbot's { user, songs: [{ title, requests }] },
  // { user: null, matches: [names] } when the name doesn't pick out one
  // person, or null when smakbot can't be reached.
  async function topRequests(user, count) {
    if (!STATUS_URL) return null;
    try {
      const url = new URL('top-songs', STATUS_URL);
      url.searchParams.set('user', /^\d{5,25}$/.test(String(user)) ? String(user) : realName(user));
      url.searchParams.set('count', String(count));
      const res = await fetch(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
      if (!res.ok) return null;
      const result = await res.json();
      return result && (Array.isArray(result.songs) || Array.isArray(result.matches)) ? result : null;
    } catch (err) {
      console.warn(`[music] can't reach smakbot's top songs (${err.message})`);
      return null;
    }
  }

  // The spoken/typed answer to "what are my top songs?" (the asker's own).
  function describeRequests(result, count) {
    if (!result) return "I can't check your top songs right now — I can't reach the music bot.";
    if (!result.songs?.length) return "I don't have any song requests from you yet.";
    const list = result.songs.slice(0, count).map((s, i) =>
      `${cleanTitle(s.title) || 'an unnamed song'}, ${s.requests}${i === 0 ? ` request${s.requests === 1 ? '' : 's'}` : ''}`);
    const head = list.length === 1 ? 'Your most requested song is' : `Your top ${list.length} requests:`;
    return `${head} ${list.join('. ')}.`;
  }

  // What the LLM's list_top_songs tool answers it when asked about one person.
  function listRequestsForModel(result, said) {
    if (!result) return 'The music bot could not be reached, so that person\'s top songs are unknown. Say so.';
    if (!result.user) {
      return result.matches?.length
        ? `"${said}" could be any of: ${result.matches.join(', ')}. Ask which one they mean.`
        : `Nobody called "${said}" is known to the music bot. Say so.`;
    }
    if (!result.songs.length) return `${result.user} hasn't requested any songs since the music bot started counting requests.`;
    return `Songs ${result.user} requested most, most first:\n` +
      result.songs.map((s, i) => `${i + 1}. ${cleanTitle(s.title)} (${s.requests} request${s.requests === 1 ? '' : 's'})`).join('\n');
  }

  return { enabled: !!STATUS_URL, get, describe, promptLine, topSongs, describeTop, listForModel,
           topRequests, describeRequests, listRequestsForModel };
}

module.exports = { createNowPlaying };
