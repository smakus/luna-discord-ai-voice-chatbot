// ─── Auto-join ────────────────────────────────────────────────────────────────
//
// AUTO_JOIN_CHANNELS: voice channels (names or IDs) Luna joins by herself when
// someone is in one and she is in no channel — at startup, or when someone
// joins. With people in several, the busiest. She posts (status messages,
// smakbot commands) in AUTO_JOIN_TEXT_CHANNEL. She still leaves when the last
// person does, and a kick is respected: she comes back only when someone next
// joins. A short delay lets someone who pops in and straight out not summon her.
//
// After being asked to leave, auto-join waits until the channels have emptied
// once (or someone types !luna), so she doesn't pop straight back in.
//
// createAutoJoin({ config, client, session, announcer, isReady, console }) →
//   check()            at startup: report settings that match nothing
//   schedule()         try to join shortly (startup, someone joined, she left)
//   pause() / resume() asked to leave / asked to join
//   onVoiceState(oldState, newState)   someone joined or left a voice channel
// named(channel, wanted) → whether a channel is one of wanted (names or IDs).

const DELAY_MS = 2000;

const named = (channel, wanted) => wanted.some(w => w === channel.id || w.toLowerCase() === String(channel.name).toLowerCase());
const guildChannels = guild => [...(guild.channels?.cache?.values() ?? [])];

function createAutoJoin({ config, client, session, announcer, isReady, console }) {
  const CHANNELS      = config.AUTO_JOIN_CHANNELS;
  const TEXT_CHANNEL  = config.AUTO_JOIN_TEXT_CHANNEL;
  let timer = null;
  let joiningUntil = 0;   // a join in progress (not Ready yet): don't start another
  let paused = false;

  const guilds = () => [...(client.guilds?.cache?.values() ?? [])];
  const textChannelFor = guild => TEXT_CHANNEL
    ? guildChannels(guild).find(c => !c.isVoiceBased?.() && c.isTextBased?.() && named(c, [TEXT_CHANNEL])) : null;

  // At startup: say which settings match nothing, and what does exist.
  function check() {
    if (!CHANNELS.length) return;
    const all = guilds().flatMap(guildChannels);
    const voices = all.filter(c => c.isVoiceBased?.()), texts = all.filter(c => !c.isVoiceBased?.() && c.isTextBased?.());
    const missing = CHANNELS.filter(w => !voices.some(c => named(c, [w])));
    if (missing.length) console.warn(`[voice] AUTO_JOIN_CHANNELS: no voice channel ${missing.map(m => `"${m}"`).join(', ')} — ` +
      `voice channels: ${voices.map(c => c.name).join(', ') || 'none'}`);
    if (!guilds().some(textChannelFor)) console.warn(`[voice] AUTO_JOIN_TEXT_CHANNEL ${TEXT_CHANNEL ? `"${TEXT_CHANNEL}" not found` : 'not set'} — ` +
      `she will post in the voice channel's own chat. Text channels: ${texts.map(c => c.name).join(', ') || 'none'}`);
    console.log(`[voice] auto-join: ${CHANNELS.join(', ')}`);
  }

  const occupied = () => guilds().some(guild => guildChannels(guild)
    .some(c => c.isVoiceBased?.() && named(c, CHANNELS) && session.realMemberCount(c) > 0));

  function schedule() {
    if (!CHANNELS.length) return;
    clearTimeout(timer);
    timer = setTimeout(join, DELAY_MS);
  }

  function join() {
    if (!isReady() || session.connection || paused || Date.now() < joiningUntil) return;
    const candidates = guilds().flatMap(guild => guildChannels(guild)
      .filter(c => c.isVoiceBased?.() && named(c, CHANNELS))
      .map(channel => ({ guild, channel, people: session.realMemberCount(channel) })))
      .filter(c => c.people > 0)
      .sort((a, b) => b.people - a.people);
    if (!candidates.length) return;
    const { guild, channel, people } = candidates[0];
    const g = { id: guild.id, adapterCreator: guild.voiceAdapterCreator };
    console.log(`[voice] auto-joining ${channel.name} (${people} ${people === 1 ? 'person' : 'people'} there)`);
    joiningUntil = Date.now() + 15000;
    const connection = session.join(channel, g);
    session.attach(connection, channel, textChannelFor(guild) || channel, g, () => { joiningUntil = 0; announcer.introduce(connection); });
  }

  function onVoiceState(oldState, newState) {
    // Asked to leave: auto-join resumes once the auto-join channels have emptied.
    if (paused && !occupied()) {
      paused = false;
      console.log('[voice] auto-join channels empty — auto-join resumes');
    }
    // Someone joined a voice channel while Luna is in none: maybe one to
    // auto-join (schedule() checks).
    if (!session.connection && newState.channelId && newState.channelId !== oldState.channelId) schedule();
  }

  return {
    check, schedule, onVoiceState,
    pause: () => { if (CHANNELS.length) paused = true; },
    resume: () => { paused = false; },
  };
}

module.exports = { createAutoJoin, named };
