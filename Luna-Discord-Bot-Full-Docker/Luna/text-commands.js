// ─── The !luna commands ───────────────────────────────────────────────────────
//
//   !luna               join the voice channel you're in (or move there)
//   !luna leave         leave the voice channel
//   !luna say <text>    say exactly that out loud, no LLM
//   !luna voicecheck    whether she can decrypt each person's voice
//   !luna wakestats     how the wake word did per person (24 h; "7d", "12h")
//   !luna help          what she can do, and where each kind of request goes
//
// Typed questions ("Luna, …") are text-chat.js's; index.js offers each message
// to that first.
//
// createTextCommands({ command, wakeLabel, isReady, session, announcer, wakeLog,
//   sayInVoice(text, userId, who) → bool, leave(userId), onJoin(), console })
//   → { onMessage(message) → true when it was a command }

// "!luna help": two messages (Discord allows 2,000 characters each). The
// three routes match commands.js: what starts with "play" (and skip, pause,
// resume, stop) goes to smakbot word for word; "what song is this?", top
// songs and goodbyes are answered without the LLM; everything else is the LLM.
function helpMessages(command) {
  return [
    [
      `**⌨️ ${command} commands** (type these in any channel)`,
      `\`${command}\` — join (or move to) the voice channel you're in`,
      `\`${command} leave\` — leave the voice channel (she stays out until it empties or someone types \`${command}\`)`,
      `\`${command} say <text>\` — say exactly that out loud, word for word`,
      `\`${command} voicecheck\` — check she can hear everyone in the call`,
      `\`${command} wakestats\` — how well "hey Luna" worked for each person today (\`${command} wakestats 7d\` for a week)`,
      `\`${command} help\` — this help`,
    ].join('\n'),
    [
      '**🗣️ Talking or typing to Luna**',
      'Say **"hey Luna, …"** in voice, or type **"Luna, …"** (or @mention her) in the text chat. Where your request goes depends on how it starts:',
      '',
      '**🎵 1. Straight to smakbot** — instant, word for word, no AI',
      '• **play** *song* — smakbot searches for exactly those words and plays the top result (one song)',
      '• **play the top 10** / **play our most played** — the server\'s most played songs',
      '• **skip** · **pause** · **resume** · **stop**',
      '"Can you play …" and "please skip" count too.',
      '',
      '**⚡ 2. Luna answers instantly** — from smakbot, no AI',
      '• **what song is this?**',
      '• **what are our top songs?** · **what are my top songs?**',
      '• **you can go now** / **bye** (voice) — she says goodbye and leaves',
      '',
      '**🧠 3. Luna thinks** — the AI, a few seconds (she tells you when she\'s searching the web)',
      'Everything else, for example:',
      '• questions: *what\'s the weather tomorrow?* · *tell me a joke*',
      '• smart music: *search for the top 4 tracks by Toto and queue them* · *put on something chill* · *queue up three Ray Charles songs*',
      '• *who requests the most songs?* · *what are kenbeans\' top songs?*',
      '• *show me a picture of a capybara* (posted in the text chat)',
      '• typed only: *Luna, say hello in Chinese in the voice channel*',
      '',
      '💡 **Want several songs or a smart pick? Don\'t start with "play."** "Play the top 4 tracks by Toto" goes to smakbot as one search for those exact words.',
    ].join('\n'),
  ];
}

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
    if (lower === `${command} help`) { help(message); return true; }
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

  // "!luna help": the reply, then the second part in the same channel.
  async function help(message) {
    const [commands, routes] = helpMessages(command);
    await message.reply({ content: commands, allowedMentions: { parse: [] } }).catch(() => {});
    await message.channel?.send?.({ content: routes, allowedMentions: { parse: [] } })?.catch?.(() => {});
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

module.exports = { createTextCommands, helpMessages };
