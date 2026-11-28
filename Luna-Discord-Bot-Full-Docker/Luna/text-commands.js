// ─── The !luna commands ───────────────────────────────────────────────────────
//
//   !luna               join the voice channel you're in (or move there)
//   !luna leave         leave the voice channel
//   !luna say <text>    say exactly that out loud, no LLM
//   !luna voicecheck    whether she can decrypt each person's voice
//   !luna wakestats     how the wake word did per person (24 h; "7d", "12h")
//
// Typed questions ("Luna, …") are text-chat.js's; index.js offers each message
// to that first.
//
// createTextCommands({ command, wakeLabel, isReady, session, announcer, wakeLog,
//   sayInVoice(text, userId, who) → bool, leave(userId), onJoin(), console })
//   → { onMessage(message) → true when it was a command }

function createTextCommands({ command, wakeLabel, isReady, session, announcer, wakeLog, sayInVoice, leave, onJoin = () => {}, console }) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const WAKESTATS = new RegExp(`^${escaped}\\s+wakestats(?:\\s+(\\d+)\\s*([dh]))?\\s*$`, 'i');
  const SAY = new RegExp(`^${escaped}\\s+say\\s+([\\s\\S]+)$`, 'i');
  // .catch on every reply: a rejected reply (e.g. no send permission) in an
  // async listener is an unhandled rejection, which terminates Node.
  const reply = (message, content) => message.reply(content).catch(() => {});

  function onMessage(message) {
    const content = String(message.content || '').trim();
    const lower = content.toLowerCase();
    if (lower === `${command} voicecheck`) { voiceCheck(message); return true; }
    // "!luna wakestats [7d|12h]": how well the wake word works for each person.
    const statsMatch = content.match(WAKESTATS);
    if (statsMatch) {
      wakeStats(message, statsMatch[1] ? Number(statsMatch[1]) : 24, (statsMatch[2] || 'h').toLowerCase());
      return true;
    }
    // "!luna say <text>": exactly those words, out loud, no LLM.
    const sayMatch = content.match(SAY);
    if (sayMatch && !message.author?.bot) {
      const who = message.member?.displayName || message.author?.username || 'someone';
      if (!sayInVoice(sayMatch[1], message.author?.id || 'text', who)) reply(message, "I'm not in a voice channel.");
      else message.react('🔊').catch(() => {});
      return true;
    }
    if (lower === `${command} leave`) {
      if (!session.connection) { reply(message, "I'm not in a voice channel."); return true; }
      reply(message, 'Bye!');
      leave(message.author?.id);
      return true;
    }
    if (lower !== command) return false;
    join(message);
    return true;
  }

  // "!luna": join the voice channel the writer is in, or move there.
  function join(message) {
    if (!isReady()) return reply(message, 'Still starting up — try again in a few seconds.');
    const channel = message.member?.voice?.channel;
    if (!channel) return reply(message, 'You need to join a voice channel first!');

    onJoin();   // asked to join: auto-join may follow people again
    const guild = { id: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator };
    // Returns the guild's existing connection if there is one, moving it to
    // `channel` when that differs.
    const connection = session.join(channel, guild);

    if (connection === session.connection) {
      if (session.channel?.id === channel.id) return reply(message, `Already listening in **${channel.name}**.`);
      // !luna from another channel: session.join() just moved Luna there.
      // Listening carries over (it is per connection, not per channel); only
      // the channel she announces and counts members in changes.
      console.log(`[voice] moved to ${channel.name} by ${command}`);
      session.moveTo(channel);
      reply(message, `Moved to **${channel.name}**!`);
      announcer.introduce(connection);
      return;
    }

    session.attach(connection, channel, message.channel, guild, () => {
      reply(message,
        `Joined **${channel.name}**! Say "${wakeLabel}" to wake me up. ` +
        `Also, you can say "${wakeLabel}, play song ___" to play music, ` +
        `or "${wakeLabel}, skip" and "${wakeLabel}, stop" to control it.`);
      announcer.introduce(connection);
    });
  }

  // "!luna voicecheck": per-person answer to "can Luna decrypt them?", plus the
  // voice privacy code to compare with the one Discord shows in the call's
  // encryption details — if they differ, Luna's whole session is out of sync.
  function voiceCheck(message) {
    if (!session.connection || !session.channel) return reply(message, "I'm not in a voice channel.");
    const crypto = session.cryptoState();
    if (!crypto) return reply(message, 'Encryption details are unavailable (unencrypted call, or the voice library changed).');
    const lines = [`**Voice encryption:** ${crypto.status}, epoch ${crypto.epoch ?? '-'}` +
      (crypto.privacyCode ? ` — privacy code \`${crypto.privacyCode}\` (should match the code Discord shows for this call)` : '')];
    for (const member of session.channel.members.values()) {
      if (member.user.bot) continue;
      const v = session.cryptoVerdict(crypto, member.id);
      lines.push(`${v.problem ? '⚠️' : '✅'} ${member.displayName}: ${v.text}`);
    }
    console.log(`[voice] voicecheck: ${lines.slice(1).join(' | ')}`);
    return reply(message, lines.join('\n'));
  }

  // "!luna wakestats": the wake-word log (wake-log.js) summed up per person.
  async function wakeStats(message, amount, unit) {
    const hours = Math.min(unit === 'd' ? amount * 24 : amount, 90 * 24) || 24;
    const span = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} h`;
    const text = await wakeLog.summary(Date.now() - hours * 3600000).catch(err => `Couldn't read the wake-word log: ${err.message}`);
    reply(message, `**Wake word, last ${span}**\n${text}`.slice(0, 1990));
  }

  return { onMessage };
}

module.exports = { createTextCommands };
