// ─── Pictures for the text chat ───────────────────────────────────────────────
//
// The LLM's post_image tool: "show me a picture of a capybara". Tavily's
// search API (TAVILY_API_KEY) is asked for images; the first result that is
// really an image (JPEG, PNG, GIF or WebP, under MAX_BYTES) is downloaded, so
// Luna can upload it as an attachment — Discord always shows those inline,
// where a link might show nothing or only a link.
//
// The tool's run() (index.js) finds the picture, so the model is told the
// truth (posted, or nothing found); the onTool handlers in text-chat.js and
// voice-answer.js then post it in the channel the question belongs to. The
// two meet through a short cache, keyed by the search words.
//
// createImageSearch({ config, fetch, console }) → { enabled, find(query) }
// find() resolves to { buffer, name, contentType, url } or null — never throws.

const SEARCH_URL   = 'https://api.tavily.com/search';
const SEARCH_MS    = 10000;
const DOWNLOAD_MS  = 8000;
const MAX_BYTES    = 8 * 1024 * 1024;   // well under Discord's upload limit
const MAX_TRIES    = 6;                 // image URLs tried before giving up
const CACHE_MS     = 2 * 60000;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

const normalize = query => String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();

function createImageSearch({ config, fetch, console }) {
  const KEY = config.TAVILY_API_KEY;
  const cache = new Map();   // normalized query → { at, promise }

  // Image URLs Tavily found for the words, best first.
  async function imageUrls(query) {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ query, include_images: true, max_results: 5, search_depth: 'basic' }),
      signal: AbortSignal.timeout(SEARCH_MS),
    });
    if (!res.ok) throw new Error(`Tavily answered ${res.status}`);
    const { images } = await res.json();
    return (Array.isArray(images) ? images : [])
      .map(i => (typeof i === 'string' ? i : i?.url))
      .filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
  }

  // The picture at a URL, if it is one Discord shows; else null.
  async function download(url, query) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MS), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return null;
      const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = TYPES[contentType];
      if (!ext) return null;
      const length = Number(res.headers.get('content-length') || 0);
      if (length > MAX_BYTES) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_BYTES) return null;
      const stem = normalize(query).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'picture';
      return { buffer, name: `${stem}.${ext}`, contentType, url };
    } catch (_) {
      return null;
    }
  }

  async function search(query) {
    try {
      const urls = await imageUrls(query);
      for (const url of urls.slice(0, MAX_TRIES)) {
        const picture = await download(url, query);
        if (picture) {
          console.log(`[image] "${query}" → ${url} (${Math.round(picture.buffer.length / 1024)} KB)`);
          return picture;
        }
      }
      console.warn(`[image] "${query}": no usable picture among ${urls.length} result(s)`);
      return null;
    } catch (err) {
      console.warn(`[image] "${query}": search failed (${err.message})`);
      return null;
    }
  }

  // The same words within CACHE_MS share one search (the tool's run() and the
  // handler that posts it ask for the same picture).
  function find(query) {
    const key = normalize(query);
    if (!KEY || !key) return Promise.resolve(null);
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
    if (!cache.has(key)) cache.set(key, { at: now, promise: search(String(query).trim()) });
    return cache.get(key).promise;
  }

  return { enabled: !!KEY, find };
}

module.exports = { createImageSearch, MAX_BYTES };
