// ─── Announcements ────────────────────────────────────────────────────────────
//
// What Luna says on her own in the voice channel: her intro when she joins,
// a greeting when someone joins (their custom one from greetings.js, if they
// have one) and a farewell when someone leaves. Bots (smakbot) and
// IGNORED_USER_IDS get a short line instead: "smakbot has joined." / "… has left."
//
// createAnnouncer(deps) → announcer.
//   session, playback   voice-session.js, voice-playback.js
//   fetchTTS, fetchTTSInVoice, checkElevenLabsVoice   tts.js (custom greetings use their own voices)
//   isIgnored(id)       IGNORED_USER_IDS
//   wakeLabel           the wake phrase as said in the intro ("hey Luna")

const path = require('path');
const { fillPhrase, speakableName } = require('./phrases');
const { loadCustomGreetings } = require('./greetings');

// "smakus", "smakus and joel", "smakus, joel, and kenbeans".
const NAME_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// More people than this and a list of names gets long: "everyone" instead.
const INTRO_MAX_NAMES = 6;

const INTRO_QUEUE_ID = 'luna:intro';

function createAnnouncer({ config, console, session, playback, fetchTTS, fetchTTSInVoice, checkElevenLabsVoice, isIgnored, wakeLabel }) {
  // ─── Settings ───────────────────────────────────────────────────────────────
  //
  // When someone joins the voice channel Luna is in, she announces them by
  // name and says hello. The cooldown is per user, so a flaky connection that
  // drops and rejoins every few seconds is greeted once, not on every
  // reconnect. A joining client takes a moment to connect its audio, and
  // someone who joins and immediately leaves (or passes through on the way to
  // another channel) should not be greeted at all: the greeting is spoken only
  // if they are still in the channel after GREET_DELAY_MS.
  //
  // Leave announcements: the same idea in reverse. The delay is longer than
  // the join one because a dropped connection typically takes a few seconds to
  // come back, and someone who is back by then did not really leave.
  //
  // Custom wording for both: phrases separated by "|", with {name} where the
  // person's name goes, e.g.
  //   FAREWELL_PHRASES={name} just left. Bye, {name}!|And {name} is gone.
  // One is picked at random each time. Unset or empty keeps the built-in lines.
  //
  // INTRO_PHRASES works the same, with {wake} for the wake phrase and {names}
  // for the people in the channel ("smakus, joel, and kenbeans") instead of
  // {name}. Phrases with {names} greet everyone by name; the others are for an
  // empty channel or a crowd.
  const GREETINGS = config.GREET_PHRASES.length ? config.GREET_PHRASES : [
    '{name} just joined. Hey {name}!',
    "Look who's here, it's {name}. Hi there!",
    '{name} has joined the channel. Hello, {name}!',
    'Heads up, {name} is here. Welcome in, {name}!',
  ];
  const FAREWELLS = config.FAREWELL_PHRASES.length ? config.FAREWELL_PHRASES : [
    '{name} just left. See you later, {name}!',
    '{name} has left the channel.',
    '{name} headed out. Bye, {name}!',
    'And {name} is gone. Catch you next time!',
  ];
  // Bots and ignored users: a short line each way (BOT_JOIN_PHRASES,
  // BOT_LEAVE_PHRASES), under the same switches, delays and cooldowns.
  const BOT_JOINS  = config.BOT_JOIN_PHRASES.length ? config.BOT_JOIN_PHRASES : ['{name} has joined.'];
  const BOT_LEAVES = config.BOT_LEAVE_PHRASES.length ? config.BOT_LEAVE_PHRASES : ['{name} has left.'];
  const INTROS = config.INTRO_PHRASES.length ? config.INTRO_PHRASES : [
    "Hey {names}! Luna here. Just say {wake} whenever you need me.",
    "Hi {names}! It's Luna. Say {wake} if you want anything.",
    "Hello {names}, Luna has arrived! Say {wake} to get my attention.",
    "Hi everyone, Luna here! Just say {wake} whenever you need me.",
    "Hey all, it's Luna. Say {wake} if you want anything.",
    "Luna has arrived! Say {wake} to get my attention.",
  ];

  const lastGreetedAt  = new Map(); // userId -> ms timestamp of their last greeting
  const lastFarewellAt = new Map(); // userId -> ms timestamp of their last farewell

  // Per-person greetings (greetings.js): their own phrases, in their own
  // ElevenLabs voice if they have one. Same cooldown and switches as the normal
  // greeting; on any problem with the custom voice, the normal greeting plays.
  // GREET_ON_JOIN=regular: everyone gets the regular greeting; the file stays.
  const CUSTOM_GREETINGS = config.GREET_ON_JOIN === 'custom'
    ? loadCustomGreetings(path.resolve(__dirname, config.GREETINGS_FILE), { warn: message => console.warn(message) })
    : new Map();

  // At startup: who has one, and whether their voices exist (no credits used).
  function describeCustomGreetings() {
    if (!CUSTOM_GREETINGS.size) return;
    console.log(`[greet] custom greetings for ${[...CUSTOM_GREETINGS].map(([id, g]) => g.name || id).join(', ')}`);
    for (const [id, g] of CUSTOM_GREETINGS) {
      if (!g.voice) continue;
      checkElevenLabsVoice(g.voice).then(({ name, reason }) => {
        if (!name) console.warn(`[greet] ${g.name || id}: ElevenLabs voice ${g.voice} unavailable (${reason}) — they'll get the normal greeting`);
      });
    }
  }

  // ─── Saying it ──────────────────────────────────────────────────────────────

  // Queued under the member's own id: if they say the wake word before the
  // announcement plays, their query supersedes it (barge-in), and an
  // announcement never cuts off an answer someone else is already hearing.
  // Skipped if Luna has left (or rejoined) in the meantime.
  function announce(member, connection, text, render) {
    playback.say(text, { connection, userId: member.id, wanted: () => session.connection === connection, render });
  }

  // ─── Intro ──────────────────────────────────────────────────────────────────

  // The speakable names of the people in the channel (not bots, not ignored
  // users), or [] when there are none or too many to list.
  function introNames(channel) {
    const names = [...(channel?.members?.values() ?? [])]
      .filter(m => !m.user.bot && !isIgnored(m.id))
      .map(m => speakableName(m.displayName))
      .filter(Boolean);
    return names.length <= INTRO_MAX_NAMES ? names : [];
  }

  // Spoken once when Luna joins, so the channel knows she is listening. Queued
  // under its own id, so nobody's query can be superseded by it or supersede it
  // by accident; whoever speaks first after it is simply answered next.
  function introduce(connection) {
    if (!config.ANNOUNCE_SELF) return;
    const names = introNames(session.channel);
    const fitting = INTROS.filter(p => p.includes('{names}') === names.length > 0);
    const text = fillPhrase(fitting.length ? fitting : INTROS, { wake: wakeLabel, names: NAME_LIST.format(names) || 'everyone' });
    console.log(`[intro] "${text}"`);
    playback.say(text, { connection, userId: INTRO_QUEUE_ID, wanted: () => session.connection === connection });
  }

  // ─── Greetings ──────────────────────────────────────────────────────────────

  // A bot or an ignored user: not greeted or bid farewell like a person.
  const isBotLike = member => member.user.bot || isIgnored(member.id);

  // The short line for a bot or ignored user arriving or leaving.
  function botLine(member, phrases, fallback) {
    const name = speakableName(member.displayName);
    return name ? fillPhrase(phrases, { name }) : fallback;
  }

  function greet(member, connection) {
    const now = Date.now();
    if (now - (lastGreetedAt.get(member.id) || 0) < config.GREET_COOLDOWN_MS) return;
    lastGreetedAt.set(member.id, now);

    if (isBotLike(member)) {
      const text = botLine(member, BOT_JOINS, 'A bot has joined.');
      console.log(`[greet] ${member.user.tag} (bot) joined — "${text}"`);
      return announce(member, connection, text);
    }

    const name = speakableName(member.displayName);
    const text = name
      ? fillPhrase(GREETINGS, { name })
      : 'Someone just joined. Hey there, welcome in!';
    const custom = CUSTOM_GREETINGS.get(member.id);
    if (custom) {
      const own = fillPhrase(custom.phrases, { name: name || 'friend', user: name || 'friend' });
      console.log(`[greet] ${member.user.tag} joined — custom greeting${custom.voice ? ` in voice ${custom.voice}` : ''}: "${own}"`);
      if (!custom.voice) return announce(member, connection, own);
      // Their own line in their own voice; if that voice can't be had, the
      // normal greeting in the normal voice.
      return announce(member, connection, own, async line => {
        const pt = await fetchTTSInVoice(line, custom.voice, { cache: true });
        if (pt) return pt;
        console.warn(`[greet] custom voice unavailable for ${member.user.tag} — normal greeting instead`);
        return fetchTTS(text, { cache: true });
      });
    }
    console.log(`[greet] ${member.user.tag} joined — "${text}"`);
    announce(member, connection, text);
  }

  // ─── Farewells ──────────────────────────────────────────────────────────────

  function farewell(member, connection) {
    const now = Date.now();
    if (now - (lastFarewellAt.get(member.id) || 0) < config.LEAVE_COOLDOWN_MS) return;
    lastFarewellAt.set(member.id, now);

    if (isBotLike(member)) {
      const text = botLine(member, BOT_LEAVES, 'A bot has left.');
      console.log(`[farewell] ${member.user.tag} (bot) left — "${text}"`);
      return announce(member, connection, text);
    }

    const name = speakableName(member.displayName);
    const text = name
      ? fillPhrase(FAREWELLS, { name })
      : 'Someone just left the channel.';
    console.log(`[farewell] ${member.user.tag} left — "${text}"`);

    // Also supersedes anything still queued for the leaver — an unplayed
    // greeting, or the rest of an answer nobody is there to hear.
    announce(member, connection, text);
  }

  // ─── Joins and leaves ───────────────────────────────────────────────────────
  //
  // Called on every VoiceStateUpdate about someone else.

  // Someone arrived in Luna's channel — from outside voice, or moved in from
  // another channel. Mute/deafen/stream toggles also emit VoiceStateUpdate but
  // keep the same channelId, so they never match.
  function onJoin(oldState, newState) {
    if (config.GREET_ON_JOIN === 'off' || !session.channel || !session.connection) return;
    if (newState.channelId !== session.channel.id) return;
    if (oldState.channelId === newState.channelId) return;

    const member = newState.member;
    if (!member) return;

    const connection = session.connection;
    setTimeout(() => {
      if (session.connection !== connection) return;
      if (member.voice.channelId !== session.channel?.id) return; // left again
      greet(member, connection);
    }, config.GREET_DELAY_MS);
  }

  // Someone left Luna's channel — disconnected from voice, or moved to another
  // channel. If they were the last real user, Luna leaves too, and the
  // session.connection check skips this.
  function onLeave(oldState, newState) {
    if (!config.ANNOUNCE_LEAVE || !session.channel || !session.connection) return;
    if (oldState.channelId !== session.channel.id) return;
    if (oldState.channelId === newState.channelId) return;

    const member = oldState.member;
    if (!member) return;

    const connection = session.connection;
    setTimeout(() => {
      if (session.connection !== connection) return;
      if (member.voice.channelId === session.channel?.id) return; // came back
      farewell(member, connection);
    }, config.LEAVE_DELAY_MS);
  }

  return { describeCustomGreetings, introduce, onJoin, onLeave };
}

module.exports = { createAnnouncer };
