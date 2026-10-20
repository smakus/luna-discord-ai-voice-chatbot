// ─── Voice session ────────────────────────────────────────────────────────────
//
// Luna's presence in a voice channel: which connection, channel and text
// channel she is using, joining and leaving, following the connection through
// network drops, and the encrypted-voice (DAVE) diagnostics and self-heal.
// Everything else asks this for the current connection instead of keeping its
// own copy.
//
// createVoiceSession(deps) → session.
//   voice              @discordjs/voice (passed in so the test harness can fake it)
//   isIgnored(userId)  IGNORED_USER_IDS
//   onConnected(connection, channel, textChannel)  start listening
//   onReset()          forget what belonged to the session (listening, playback, memory)

const { decideSilentSpeaker } = require('./voice-input');

function createVoiceSession({ config, voice, console, isIgnored, onConnected, onReset }) {
  const { joinVoiceChannel, VoiceConnectionStatus, entersState } = voice;

  let connection  = null;
  let channel     = null;
  let textChannel = null;   // where !luna was typed (or the auto-join one); music commands go here
  let guild       = null;   // { id, adapterCreator }, for reconnecting

  // People who count as company: not bots, not ignored users.
  const realMemberCount = voiceChannel =>
    voiceChannel ? voiceChannel.members.filter(m => !m.user.bot && !isIgnored(m.id)).size : 0;

  // ─── Joining ────────────────────────────────────────────────────────────────

  // debug: true so the voice library's encryption (DAVE) messages reach
  // logVoiceDebug; everything else it says is filtered out there. Returns the
  // guild's existing connection if there is one, moving it to `channel` when
  // that differs.
  function join(toChannel, toGuild) {
    return joinVoiceChannel({
      channelId: toChannel.id,
      guildId: toGuild.id,
      adapterCreator: toGuild.adapterCreator,
      debug: true,
    });
  }

  // Starts the session on a new connection once it is Ready. Shared by !luna,
  // auto-join and the encrypted-session reconnect; `onJoined` runs after setup
  // (reply, intro).
  function attach(conn, toChannel, toTextChannel, toGuild, onJoined = null) {
    watch(conn);

    // Once, not on: a connection returns to Ready after every network blip, and
    // re-running this would re-post the join message and stack another
    // speaking listener each time.
    const onReady = () => {
      connection  = conn;
      channel     = toChannel;
      textChannel = toTextChannel;
      guild       = toGuild;
      onConnected(conn, toChannel, toTextChannel);
      if (onJoined) onJoined();
    };

    if (conn.state.status === VoiceConnectionStatus.Ready) {
      onReady();
    } else {
      conn.once(VoiceConnectionStatus.Ready, onReady);
    }
  }

  // Luna is now in `toChannel` on the same connection (moved by !luna or by
  // someone dragging her). Listening carries over: it is per connection.
  function moveTo(toChannel) { channel = toChannel; }

  // ─── Connection lifecycle ───────────────────────────────────────────────────

  const watched = new WeakSet();

  function watch(conn) {
    if (watched.has(conn)) return;
    watched.add(conn);

    // Kicked, moved, or a network drop. A move or a blip starts reconnecting
    // within seconds; anything else is gone for good, and without this Luna
    // kept believing she was connected — queueing speech into a dead connection
    // and announcing joins for a channel she had left.
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        console.warn('[voice] connection lost and did not recover — leaving');
        try { conn.destroy(); } catch (_) {}
      }
    });

    conn.on(VoiceConnectionStatus.Destroyed, () => {
      if (connection === conn) reset();
    });

    conn.on('debug', logVoiceDebug);
  }

  // Forgets everything tied to the current voice session.
  function reset() {
    connection  = null;
    channel     = null;
    textChannel = null;
    guild       = null;
    silentSpeakers.clear();
    onReset();
  }

  function leave(reason) {
    const conn = connection;
    if (!conn) return;
    console.log(`[voice] ${reason} — disconnecting.`);
    reset();
    // Throws if the connection was already destroyed (e.g. Luna was kicked
    // from the channel), and an exception here escapes into discord.js.
    try { conn.destroy(); } catch (_) {}
  }

  // Leave and rejoin the same channel, quietly (no reply, no intro).
  function reconnect() {
    const toChannel = channel, toTextChannel = textChannel, toGuild = guild;
    if (!toChannel || !toGuild) return;
    leave('reconnecting');
    setTimeout(() => {
      if (connection) return;   // someone ran !luna in the meantime
      const conn = join(toChannel, toGuild);
      attach(conn, toChannel, toTextChannel, toGuild, () => console.log(`[voice] reconnected to ${toChannel.name}`));
    }, 1500);
  }

  // ─── Encrypted voice (DAVE): logging and self-heal ──────────────────────────
  //
  // Discord voice is end-to-end encrypted. Occasionally the bot's session loses
  // one speaker's keys: Discord keeps reporting them speaking (the voice library
  // records that before decrypting), but every packet fails to decrypt and is
  // dropped with only a debug message. To Luna that speaker is simply silent —
  // it looks exactly like her ignoring the wake word — while everyone else in
  // the channel hears them fine. Them rejoining does not fix it; a fresh voice
  // session for Luna does. Hence:
  //   - logVoiceDebug: the library's [DAVE] messages, decrypt failures counted
  //     and summarised at most every 10 s;
  //   - a speaker reported speaking for VOICE_RECOVER_MS with no audio arriving
  //     makes Luna reconnect (at most once per 5 minutes). 0 disables.
  const VOICE_RECOVER_MS     = config.VOICE_RECOVER_MS;
  const VOICE_RECOVER_GAP_MS = 5 * 60000;
  const silentSpeakers = new Map();   // userId -> when Discord first said they spoke, with no audio since
  let lastRecoveryAt  = 0;
  let decryptFailures = 0;
  let decryptLoggedAt = 0;

  function logVoiceDebug(message) {
    if (!message.includes('[DAVE]')) return;
    const text = message.replace(/^.*?\[DAVE\]\s*/, '');
    if (/failed to decrypt/i.test(text)) {
      decryptFailures++;
      const now = Date.now();
      if (now - decryptLoggedAt >= 10000) {
        console.warn(`[voice] encrypted audio: ${decryptFailures} packet(s) failed to decrypt (latest: ${text})`);
        decryptFailures = 0;
        decryptLoggedAt = now;
      }
      return;
    }
    console.log(`[voice] encryption: ${text}`);
  }

  // Encryption diagnostics. Whether Luna can decrypt a given speaker, read from
  // the DAVE session itself rather than inferred from silence: is the speaker in
  // her MLS group (no keys otherwise), and how many of their packets decrypted
  // or failed. Discord's "speaking" signal fires when packets arrive, before
  // decryption, so "speaking + failures + 0 decrypted" is a decryption problem,
  // and "speaking + no packets at all" means they never reached decryption.
  // Read through the voice library's internal session object (not public API):
  // if a library update moves it, this returns null and logs once.
  let cryptoDiagWarned = false;
  function cryptoState() {
    const conn = connection;
    const dave = conn?.state?.networking?.state?.dave;
    if (!dave) return null;
    const session = dave.session;
    if (!session || typeof session.getUserIds !== 'function' || typeof session.getDecryptionStats !== 'function') {
      if (!cryptoDiagWarned && dave.protocolVersion > 0) {
        cryptoDiagWarned = true;
        console.warn('[voice] encryption diagnostics unavailable — the voice library\'s internals have changed');
      }
      return null;
    }
    let members = null;
    try { members = new Set(session.getUserIds()); } catch (_) {}
    let privacyCode = null;
    try { privacyCode = conn.voicePrivacyCode || null; } catch (_) {}
    return {
      status: ['inactive', 'pending', 'awaiting response', 'active'][session.status] ?? String(session.status),
      epoch: session.epoch != null ? String(session.epoch) : null,
      privacyCode,
      members,
      stats: userId => { try { return session.getDecryptionStats(userId); } catch (_) { return null; } },
    };
  }

  // One speaker's encryption state: { inGroup, ok, failed, problem, text }.
  function cryptoVerdict(state, userId) {
    if (!state) return null;
    const inGroup = state.members ? state.members.has(userId) : null;
    const st = state.stats(userId);
    const ok = st ? st.successes : 0, failed = st ? st.failures : 0;
    const problem = inGroup === false || (failed > 0 && ok === 0);
    const group = inGroup === null ? 'group unknown' : inGroup ? 'in group' : 'NOT in group';
    return { inGroup, ok, failed, problem, text: st ? `${group}, ${ok} decrypted/${failed} failed` : `${group}, no packets yet` };
  }

  // Discord reported `userId` speaking (receiver 'start').
  function noteSpeaking(userId) {
    if (!VOICE_RECOVER_MS || silentSpeakers.has(userId)) return;
    silentSpeakers.set(userId, Date.now());
    setTimeout(() => checkSilentSpeaker(userId), VOICE_RECOVER_MS);
  }

  // Decoded audio arrived from `userId`: their audio is fine.
  function noteAudio(userId) {
    silentSpeakers.delete(userId);
  }

  function checkSilentSpeaker(userId) {
    const since = silentSpeakers.get(userId);
    if (!since || !connection) return;
    // Timers can fire a millisecond early. Returning then left the speaker in
    // silentSpeakers, so noteSpeaking never scheduled another check and
    // recovery for them silently never ran: check again when it is time.
    const early = VOICE_RECOVER_MS - (Date.now() - since);
    if (early > 0) { setTimeout(() => checkSilentSpeaker(userId), early + 1); return; }
    silentSpeakers.delete(userId);
    const name = channel?.members?.get(userId)?.displayName || userId;
    const verdict = cryptoVerdict(cryptoState(), userId);
    const why = verdict ? ` (encryption: ${verdict.text})` : '';
    const action = decideSilentSpeaker({ verdict, now: Date.now(), lastReconnectAt: lastRecoveryAt, gapMs: VOICE_RECOVER_GAP_MS });
    if (action === 'restart-capture') {
      // Encryption is fine, so a reconnect (which disrupts everyone) would not
      // help: restart just this speaker's capture; Discord's next "speaking"
      // starts a fresh one.
      console.warn(`[voice] Discord reports ${name} speaking and their audio is decrypting${why}, ` +
        'but none of it reached Luna — restarting their capture (not an encryption problem)');
      connection.receiver.subscriptions.get(userId)?.destroy();
      return;
    }
    if (action === 'wait') {
      console.warn(`[voice] still no decryptable audio from ${name}${why}; already reconnected recently, not retrying yet`);
      return;
    }
    lastRecoveryAt = Date.now();
    console.warn(`[voice] Discord reports ${name} speaking, but none of their audio has decrypted in ` +
      `${Math.round(VOICE_RECOVER_MS / 1000)}s${why} — reconnecting for a fresh encrypted session`);
    reconnect();
  }

  return {
    get connection()  { return connection; },
    get channel()     { return channel; },
    get textChannel() { return textChannel; },
    join, attach, moveTo, leave, reconnect,
    noteSpeaking, noteAudio, cryptoState, cryptoVerdict, realMemberCount,
  };
}

module.exports = { createVoiceSession };
