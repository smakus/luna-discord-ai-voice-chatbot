require('dotenv').config();

const {
  joinVoiceChannel, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer,
  EndBehaviorType,
} = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const prism = require('prism-media');
const { execFile } = require('child_process');
const fs = require('fs');
const { PassThrough } = require('stream');

// ─── Config ───────────────────────────────────────────────────────────────────

const WAKE_WORDS = ['luna', 'loona'];

const IGNORED_USERS = new Set(
  (process.env.IGNORED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
);

const WHISPER_CLI   = process.env.WHISPER_CLI || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const LM_STUDIO_URL = process.env.LM_STUDIO_URL;
const LM_SYSTEM_PROMPT =
  'You are Luna, a helpful voice assistant in a Discord voice channel. ' +
  'The user will address you by saying "Luna" at the start of their message — ' +
  'ignore this prefix and just respond to the rest. Keep responses concise and ' +
  'conversational — no markdown, no bullet points, no emojis, just natural spoken ' +
  'sentences. Do not ask follow-up questions unless necessary for data. You have ' +
  'access to the internet via a web search tool and should use it whenever asked ' +
  'about current events, prices, weather, news, scores, or anything time-sensitive.';

const KOKORO_URL   = process.env.KOKORO_URL;
const KOKORO_VOICE = process.env.KOKORO_VOICE;

// ─── Latency tuning ───────────────────────────────────────────────────────────
// Reduced from 1500ms → 600ms: saves ~900ms on every single interaction.
const SILENCE_MS       = 1000;
const ENERGY_THRESHOLD = 300;
const MIN_SPEECH_MS    = 300;

// Sentence boundary regex — triggers TTS as soon as a sentence is complete
// rather than waiting for the full LLM response.
const SENTENCE_END = /(?<!\d)[.!?](?!\d)[\s"')\]]*(?:\s|$)/;

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
  ],
});

let lmStudioModel = null;

async function resolveModel() {
  try {
    const res = await fetch(
      LM_STUDIO_URL.replace('/api/v1/chat', '/api/v1/models'),
      { headers: { 'Authorization': `Bearer ${process.env.LM_STUDIO_MCP_BEARER_TOKEN}` } }
    );
    const data = await res.json();
    const loaded = data?.models?.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
    if (!loaded) throw new Error('No models loaded');
    lmStudioModel = loaded.loaded_instances[0].id;
    console.log(`Using LM Studio model: ${lmStudioModel}`);
  } catch (err) {
    console.error('Failed to resolve LM Studio model:', err.message);
    process.exit(1);
  }
}

client.on(Events.ClientReady, async () => {
  await resolveModel();
  console.log('Ready! Wake word: ' + WAKE_WORDS[0]);
});

// ─── Voice join ───────────────────────────────────────────────────────────────

let activeConnection   = null;
let activeVoiceChannel = null;
const listeningUsers   = new Set();

client.on(Events.MessageCreate, async message => {
  if (message.content.toLowerCase() === '!' + WAKE_WORDS[0]) {
    const channel = message.member?.voice?.channel;
    if (!channel) return message.reply('You need to join a voice channel first!');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      message.reply(
        `Joined **${channel.name}**! Say "${WAKE_WORDS[0]}" to wake me up. ` +
        `Also, you can say "${WAKE_WORDS[0]}, play song ___" to play music.`
      );
      activeConnection   = connection;
      activeVoiceChannel = channel;
      startListening(connection, message.channel);

      // Subscribe to users already in the channel at join time
      channel.members.forEach(member => {
        if (member.user.bot)               return;
        if (IGNORED_USERS.has(member.id))  return;
        if (listeningUsers.has(member.id)) return;
        listeningUsers.add(member.id);
        continuousCapture(connection, member.id, message.channel);
      });
    });
  }
});

// ─── Core listening loop ──────────────────────────────────────────────────────

function getRealMemberCount(voiceChannel) {
  if (!voiceChannel) return 0;
  return voiceChannel.members.filter(m => !m.user.bot && !IGNORED_USERS.has(m.id)).size;
}

function startListening(connection, channel) {
  connection.receiver.speaking.on('start', userId => {
    if (listeningUsers.has(userId))   return;
    if (userId === client.user.id)    return; // ignore bot's own audio
    if (IGNORED_USERS.has(userId))    return; // ignore configured bots/users
    listeningUsers.add(userId);
    continuousCapture(connection, userId, channel);
  });
}

function hasEnergy(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length - 1; i += 2) {
    sum += Math.abs(chunk.readInt16LE(i));
  }
  return (sum / (chunk.length / 2)) > ENERGY_THRESHOLD;
}

function continuousCapture(connection, userId, channel) {
  const audioStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 60000 },
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
  audioStream.setMaxListeners(20);
  audioStream.pipe(decoder);
  decoder.on('error', () => {}); // ignore corrupted Opus packets

  let speechChunks = [];
  let silenceTimer = null;
  let speaking     = false;
  let flushing     = false;
  let lastDataTime = Date.now();

  function flushUtterance() {
    silenceTimer = null;
    if (flushing || speechChunks.length === 0) return;
    flushing = true;
    const pcm = Buffer.concat(speechChunks);
    speechChunks = [];
    speaking     = false;

    const durationMs = (pcm.length / 2 / 48000) * 1000;
    if (durationMs < MIN_SPEECH_MS) { flushing = false; return; }

    console.log(`[${userId}] Processing ${Math.round(durationMs)}ms utterance...`);
    processUtterance(pcm, userId, connection, channel).finally(() => { flushing = false; });
  }

  decoder.on('data', chunk => {
    lastDataTime = Date.now();

    if (hasEnergy(chunk)) {
      if (!speaking) {
        speaking = true;
        console.log(`[${userId}] Speech started`);
      }
      speechChunks.push(chunk);
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(flushUtterance, SILENCE_MS);
    } else if (speaking) {
      speechChunks.push(chunk);
    }
  });

  // Discord stops sending Opus packets when truly silent — track real time elapsed
  // and flush if we've been speaking and no data arrives for SILENCE_MS
  const dataWatchdog = setInterval(() => {
    if (speaking && Date.now() - lastDataTime > SILENCE_MS) {
      flushUtterance();
    }
  }, 100);

  audioStream.once('close', () => {
    clearInterval(dataWatchdog);
    if (silenceTimer) clearTimeout(silenceTimer);
    listeningUsers.delete(userId);
    // Stream closed — speaking.start will re-trigger continuousCapture next time user speaks
  });

  audioStream.once('error', err => {
    console.error(`[${userId}] Stream error:`, err);
    clearInterval(dataWatchdog);
    if (silenceTimer) clearTimeout(silenceTimer);
    listeningUsers.delete(userId);
  });
}

const processingUsers = new Set(); // tracks who is currently being transcribed/responded to

// ─── Playback queue ───────────────────────────────────────────────────────────
// Serializes TTS sentences within a single response.
//
// Generation counter: every new query increments `currentGeneration`.
// Each sentence closure captures its generation at queue time. When the
// closure executes, it compares against `currentGeneration` — if they differ,
// a newer query has arrived and this sentence is silently skipped.
// This eliminates the race condition where stale sentences from an old
// response play alongside a new response.

let playbackQueue     = Promise.resolve();
let currentPlayer     = null;
let currentGeneration = 0;  // incremented on every new query

function queuePlayback(fn, generation) {
  playbackQueue = playbackQueue.then(async () => {
    if (generation !== currentGeneration) return; // stale — skip
    await fn();
  }).catch(() => {});
}

function interruptPlayback() {
  // Advance generation — all queued sentences from previous response will
  // see a mismatch and skip themselves when they eventually execute.
  currentGeneration++;
  // Stop the currently playing sentence immediately
  if (currentPlayer) {
    try { currentPlayer.stop(true); } catch (_) {}
    currentPlayer = null;
  }
  // Fresh queue for the new response
  playbackQueue = Promise.resolve();
}

// ─── WAV helper ───────────────────────────────────────────────────────────────

function writeWav(filePath, pcmData, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4); // file size - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                 // fmt chunk size
  header.writeUInt16LE(1,  20);                 // PCM format
  header.writeUInt16LE(channels, 22);           // num channels
  header.writeUInt32LE(sampleRate, 24);         // sample rate
  header.writeUInt32LE(byteRate, 28);           // byte rate
  header.writeUInt16LE(blockAlign, 32);         // block align
  header.writeUInt16LE(bitDepth, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);     // data chunk size

  fs.writeFileSync(filePath, Buffer.concat([header, pcmData]));
}

// ─── Whisper ──────────────────────────────────────────────────────────────────

function transcribeWithWhisper(wavPath) {
  return new Promise(resolve => {
    execFile(
       	WHISPER_CLI,
 	 ['-m', WHISPER_MODEL, '-f', wavPath, '-t', '8', '-bs', '1', '-bo', '1'],
  	{ timeout: 15000 }, // kill if whisper hangs for 15s
      (error, stdout) => {
        if (error) {
          console.error('Whisper error:', error.message);
          return resolve(null); // resolve null instead of reject to keep bot running
        }
        const lines = stdout.split('\n')
          .map(l => l.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim())
          .filter(l => l && l !== '[BLANK_AUDIO]');
        resolve(lines.join(' ').trim() || null);
      }
    );
  });
}

// ─── Utterance processing ─────────────────────────────────────────────────────

async function processUtterance(pcm, userId, connection, channel) {
  // Per-user whisper lock — prevents stacking multiple simultaneous transcriptions
  // for the same user. Does NOT block audio collection, so the wake word is always
  // detectable even while Luna is speaking a response.
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);

  const wavPath = `/tmp/discordai_${userId}_${Date.now()}.wav`;

  try {
    writeWav(wavPath, pcm, 48000, 1, 16);
    const transcript = await transcribeWithWhisper(wavPath);
    try { fs.unlinkSync(wavPath); } catch (_) {}

    if (!transcript) return;

    const lower = transcript.toLowerCase().trim();
    const startsWithWake = WAKE_WORDS.some(w => {
      const idx = lower.indexOf(w);
      return idx !== -1 && idx < 6;
    });
    if (!startsWithWake) return;

    console.log(`[${userId}] Query:`, transcript);
    // handleQuery calls interruptPlayback() internally — if Luna is mid-response
    // she will stop immediately and answer the new query.
    await handleQuery(transcript, connection, channel);
  } catch (err) {
    console.error(`[${userId}] Error processing utterance:`, err);
    try { fs.unlinkSync(wavPath); } catch (_) {}
  } finally {
    processingUsers.delete(userId);
  }
}

// ─── Sound effect ─────────────────────────────────────────────────────────────

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

// ─── Intent detection ─────────────────────────────────────────────────────────

const SEARCH_KEYWORDS = [
  // time-sensitive
  'today', 'tonight', 'yesterday', 'tomorrow', 'this week', 'this month',
  'right now', 'currently', 'current', 'latest', 'recent',
  // factual lookups
  'price', 'cost', 'weather', 'forecast', 'temperature',
  'news', 'score', 'result', 'standing', 'ranking',
  'stock', 'crypto', 'bitcoin', 'market',
  // question patterns that imply real-world data
  'who is', 'who are', 'who won', 'who plays',
  'what happened', 'what time is',
  'when is', 'when does', 'when did',
  'where is', 'where are',
  'how much does', 'how much is',
  'is there a',
];

function needsWebSearch(query) {
  const lower = query.toLowerCase();
  return SEARCH_KEYWORDS.some(k => lower.includes(k));
}

function extractSmakbotCommand(query) {
  const lower = query.toLowerCase();
  for (const word of WAKE_WORDS) {
    const idx = lower.indexOf(word);
    if (idx === -1 || idx >= 6) continue;
    const after = query.slice(idx + word.length).replace(/^[,.\s]+/, '');
    const match = after.match(/^play(?:\s+(?:the\s+)?(?:song|music))?[,.]?\s+(.+)/i);
    if (match) return match[1].trim().replace(/[,.]+$/, '');
  }
  return null;
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(query, connection, channel) {
  // Check for smakbot music command first
  const songRequest = extractSmakbotCommand(query);
  if (songRequest) {
    console.log(`Smakbot command: !play ${songRequest}`);
    await channel.send(`!play ${songRequest}`).catch(err =>
      console.error('Failed to send play music command:', err.message)
    );
    queuePlayback(async () => {
      const pt = await fetchTTS(`Okay, playing ${songRequest}.`);
      if (pt) await playTTS(pt, connection);
    }, currentGeneration);
    return;
  }

  // Interrupt any ongoing playback — new query takes priority.
  // interruptPlayback() increments currentGeneration so all queued sentences
  // from the previous response skip themselves when they reach the front.
  interruptPlayback();
  const myGeneration = currentGeneration; // capture for this response's closures

  // Fire chime (don't await — let it play while we fetch the LLM response)
  playSound('./chime.mp3', connection).catch(() => {});
  const statusMsg = await channel.send('🤔 *Luna is thinking...*').catch(() => null);

  console.log(`[LLM] Querying for: ${query}`);

  try {
    // Prefetch pipeline — fetchTTS fires immediately when LLM yields a sentence,
    // so Kokoro is generating sentence N+1 while sentence N is playing.
    let firstSentence = true;
    const prefetchMap = new Map();
    let sentenceIndex = 0;

    for await (const sentence of getLMStudioResponseStreaming(query)) {
      if (!sentence.trim()) continue;
      // If a newer query arrived mid-stream, abort fetching remaining sentences
      if (myGeneration !== currentGeneration) break;
      console.log('Luna sentence:', sentence);

      if (firstSentence) {
        firstSentence = false;
        try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
      }

      // Kick off Kokoro fetch immediately — runs in background
      const idx = sentenceIndex++;
      const audioPromise = fetchTTS(sentence);
      prefetchMap.set(idx, audioPromise);

      // Queue play — passes myGeneration so stale sentences auto-skip
      queuePlayback(async () => {
        const passThrough = await prefetchMap.get(idx);
        prefetchMap.delete(idx);
        if (passThrough) await playTTS(passThrough, connection);
      }, myGeneration);
    }

    // Clean up status message if LLM returned nothing
    if (firstSentence) {
      try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
    }
  } catch (err) {
    console.error('handleQuery error:', err);
    try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
    queuePlayback(async () => {
      const pt = await fetchTTS('I had trouble processing that.');
      if (pt) await playTTS(pt, connection);
    }, myGeneration);
  }
}

// ─── Conversation memory ──────────────────────────────────────────────────────

let previousResponseId = null;

// ─── LLM streaming ───────────────────────────────────────────────────────────
//
// Yields complete sentences as the LLM generates them.
//
// Strategy:
//   1. Try LM Studio's responses API with stream:true (SSE).
//      If it returns SSE data: lines, yield sentences as they arrive.
//   2. If the response is plain JSON (LM Studio ignoring stream:true),
//      fall back to parsing it as a normal response and chunking into
//      sentences ourselves — still faster than the old single speakResponse call.

async function* getLMStudioResponseStreaming(text) {
  const useSearch = needsWebSearch(text);

  const body = {
    model: lmStudioModel,
    input: text,
    stream: true,
    ...(useSearch && {
      integrations: [{
        type: 'ephemeral_mcp',
        server_label: 'tavily',
        server_url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`,
      }],
    }),
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  } else {
    body.system_prompt = LM_SYSTEM_PROMPT;
  }

  console.log(`[LLM] POST ${LM_STUDIO_URL} model=${lmStudioModel} stream=true useSearch=${useSearch}`);

  const res = await fetch(LM_STUDIO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LM_STUDIO_MCP_BEARER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`[LLM] Response status: ${res.status} content-type: ${res.headers.get('content-type')}`);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LM Studio ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get('content-type') || '';

  // ── Path A: SSE streaming ─────────────────────────────────────────────────
  if (contentType.includes('text/event-stream')) {
    console.log('[LLM] Streaming SSE mode');
    let buffer     = '';
    let sseBuffer  = '';
    let responseId = null;
    const reader   = res.body.getReader();
    const decoder  = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          let parsed;
          try { parsed = JSON.parse(trimmed.slice(6)); } catch { continue; }

          // response_id lives inside chat.end result
          if (parsed.type === 'chat.end' && parsed.result?.output) {
            const msg = parsed.result.output.filter(o => o.type === 'message').pop();
            if (msg?.content) responseId = parsed.result?.response_id ?? null;
          }

          // LM Studio SSE format: {type:'message.delta', content:'token'}
          const delta = parsed.type === 'message.delta' ? (parsed.content ?? '') : '';

          if (!delta) continue;
          buffer += delta;

          let match;
          while ((match = SENTENCE_END.exec(buffer)) !== null) {
            const endIdx   = match.index + match[0].length;
            const sentence = buffer.slice(0, endIdx).trim();
            buffer = buffer.slice(endIdx);
            if (sentence) yield sentence;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const remainder = buffer.trim();
    if (remainder) yield remainder;
    if (responseId) previousResponseId = responseId;

  // ── Path B: Plain JSON fallback (responses API without true streaming) ─────
  } else {
    console.log('[LLM] Non-streaming JSON mode (chunking response into sentences)');
    const data = await res.json();
    console.log('[LLM] Raw response keys:', Object.keys(data));

    if (data.response_id) previousResponseId = data.response_id;

    // Extract full reply text from responses API format
    const messageItem = data.output?.filter(o => o.type === 'message').pop();
    const fullText    = messageItem?.content?.trim();

    if (!fullText) {
      console.error('[LLM] No content found in response:', JSON.stringify(data).slice(0, 300));
      throw new Error('No message content in LLM response');
    }

    console.log('[LLM] Full response:', fullText);

    // Split into sentences and yield each one so TTS starts immediately
    let remaining = fullText;
    let match;
    while ((match = SENTENCE_END.exec(remaining)) !== null) {
      const endIdx   = match.index + match[0].length;
      const sentence = remaining.slice(0, endIdx).trim();
      remaining = remaining.slice(endIdx);
      if (sentence) yield sentence;
    }
    if (remaining.trim()) yield remaining.trim();
  }
}

// ─── TTS: fetch and play (split for prefetch pipeline) ──────────────────────
//
// fetchTTS()  — starts the Kokoro request and returns a PassThrough stream.
//               Called as soon as a sentence is ready, even while a previous
//               sentence is still playing, so audio is ready with zero wait.
//
// playTTS()   — subscribes the stream to the Discord player and awaits completion.
//               Called by the playback queue in order.

async function fetchTTS(text) {
  try {
    const res = await fetch(KOKORO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice: KOKORO_VOICE, stream: true }),
    });

    if (!res.ok) {
      console.error(`Kokoro error ${res.status}:`, await res.text());
      return null;
    }

    // Pipe HTTP response body into a PassThrough so playTTS can consume it
    const passThrough = new PassThrough();
    const reader = res.body.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { passThrough.end(); break; }
          passThrough.write(value);
        }
      } catch (err) {
        passThrough.destroy(err);
      }
    })();

    return passThrough;
  } catch (err) {
    console.error('fetchTTS error:', err);
    return null;
  }
}

async function playTTS(passThrough, connection) {
  try {
    const player   = createAudioPlayer();
    const resource = createAudioResource(passThrough, {
      inputType: StreamType.Arbitrary,
    });

    currentPlayer = player; // track so interruptPlayback() can stop it
    connection.subscribe(player);
    player.play(resource);

    await new Promise(resolve => {
      player.on(AudioPlayerStatus.Idle, () => { player.stop(); currentPlayer = null; resolve(); });
      player.on('error', err => { console.error('Player error:', err); currentPlayer = null; resolve(); });
      setTimeout(() => { currentPlayer = null; resolve(); }, 30000);
    });
  } catch (err) {
    console.error('playTTS error:', err);
    currentPlayer = null;
  }
}

client.on(Events.Error, console.warn);

// Disconnect when the last real user (non-bot, non-ignored) leaves
client.on(Events.VoiceStateUpdate, (oldState, _newState) => {
  if (!activeVoiceChannel || oldState.channelId !== activeVoiceChannel.id) return;
  if (getRealMemberCount(activeVoiceChannel) === 0) {
    console.log('[voice] Last real user left — disconnecting.');
    activeConnection.destroy();
    activeConnection   = null;
    activeVoiceChannel = null;
    listeningUsers.clear();
    previousResponseId = null;
  }
});

void client.login(process.env.DISCORD_TOKEN);
