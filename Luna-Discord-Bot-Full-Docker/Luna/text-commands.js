// ─── The !luna commands ───────────────────────────────────────────────────────
//
//   !luna               join the voice channel you're in (or move there)
//   !luna leave         leave the voice channel
//   !luna say <text>    say exactly that out loud, no LLM
//   !luna voicecheck    whether she can decrypt each person's voice
//   !luna wakestats     how the wake word did per person (24 h; "7d", "12h")
//   !luna help          what she can do, and where each kind of request goes
//   !luna voices        the Chatterbox voices she can speak in
//   !luna voice [name] <text> [--file]   say it in one of those voices ("default"
//                       when no name is given); --file posts a .wav instead
//
// Typed questions ("Luna, …") are text-chat.js's; index.js offers each message
// to that first.
//
// createTextCommands({ command, wakeLabel, isReady, session, announcer, wakeLog,
//   sayInVoice(text, userId, who) → bool, leave(userId), onJoin(), console,
//   voices: { list() → [names] | null, say(text, voice, userId, who) → bool,
//             wav(text, voice) → Buffer }, maxChars })
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
      `\`${command} voice <name> <text>\` — say it in one of the cloned voices (add \`--file\` for a .wav)`,
      `\`${command} voices\` — list the voices`,
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

function createTextCommands({ command, wakeLabel, isReady, session, announcer, wakeLog, sayInVoice, leave, onJoin = () => {}, console,
                              voices = null, maxChars = 400 }) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const VOICE = new RegExp(`^${escaped}\\s+voice(?:\\s+([\\s\\S]*))?$`, 'i');
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
    if (lower === `${command} voices`) { listVoices(message); return true; }
    const voiceMatch = content.match(VOICE);
    if (voiceMatch && !message.author?.bot) { speakAs(message, voiceMatch[1] || ''); return true; }
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

  // "!luna voices": the Chatterbox voices, live from its server, so a new
  // clone (<name>.wav in its voices folder) shows up without a restart.
  async function listVoices(message) {
    const names = await voices?.list();
    if (!names) return reply(message, "Chatterbox isn't running, so there are no voices to use right now.");
    const shown = names.map(n => n === 'default' ? '`default` (built into the model; used when you don\'t name one)' : `\`${n}\``);
    reply(message, `**🎙️ Voices:** ${shown.join(' · ')}\n` +
      `\`${command} voice <name> <text>\` says it in the voice channel · \`${command} voice <text>\` uses \`default\` · ` +
      `add \`--file\` to get a .wav instead`);
  }

  // "!luna voice [name] <text> [--file]": the text in one of Chatterbox's
  // voices. The first word picks the voice when it is one ("default"
  // otherwise). Spoken in the voice channel like "!luna say", or with
  // --file posted as a .wav to download.
  async function speakAs(message, rest) {
    const file = /(^|\s)--file(?=\s|$)/i.test(rest);
    let words = rest.replace(/(^|\s)--file(?=\s|$)/gi, ' ').trim();
    const names = await voices?.list();
    if (!names) return reply(message, "Chatterbox isn't running, so I can't use its voices right now.");
    const first = words.split(/\s+/)[0] || '';
    const named = names.find(n => n.toLowerCase() === first.toLowerCase());
    const voice = named || 'default';
    if (named) words = words.slice(first.length).trim();
    const text = words.slice(0, maxChars);
    if (!text) return reply(message, `Say what? \`${command} voice <name> <text>\` — voices: ${names.map(n => `\`${n}\``).join(', ')}`);
    const who = message.member?.displayName || message.author?.username || 'someone';

    if (file) {
      message.channel?.sendTyping?.().catch(() => {});
      try {
        const wav = await voices.wav(text, voice);
        const stem = text.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'line';
        console.log(`[voice] ${who} rendered ${voice}: ${JSON.stringify(text)} (${Math.round(wav.length / 1024)} KB .wav)`);
        return message.reply({ content: `🎙️ \`${voice}\`: ${text}`, files: [{ attachment: wav, name: `${voice}-${stem}.wav` }],
                               allowedMentions: { parse: [] } }).catch(() => {});
      } catch (err) {
        console.warn(`[voice] ${voice} .wav failed: ${err.message}`);
        return reply(message, `Couldn't render that in \`${voice}\`: ${err.message}`);
      }
    }
    if (!voices.say(text, voice, message.author?.id || 'text', who)) {
      return reply(message, `I'm not in a voice channel. Add \`--file\` to get it as a .wav instead.`);
    }
    message.react('🔊').catch(() => {});
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
