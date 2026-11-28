// ─── What Luna does, by voice or by text ──────────────────────────────────────
//
// The parts of answering that are the same whether the question was spoken
// (voice-answer.js) or typed (text-chat.js). Each of those only decides how
// the result is delivered: said out loud, or posted.
//
//   musicCommand(what, ctx)  a fixed music command ("play …", "skip"): sent to
//                            smakbot; resolves to what to say about it
//                            ("Adding … to the queue."), or '' for nothing
//   fixedAnswer(what, ctx)   "what song is this?", "what are our / my top
//                            songs?": the answer from smakbot, or null when the
//                            question should go to the LLM instead
//   toolHandler(ctx)         turns the LLM's tool calls (answer-llm.js) into
//                            actions: music to smakbot, pictures found, a line
//                            said in voice, leaving. Returns { onTool, musicCalled() }
//   musicFollowUp(ctx)       after an answer that said music was queued but
//                            called no music tool: one quiet follow-up so the
//                            model can make the calls (see llm-tools.js)
//
// ctx: { channel, guildId, userId, ... } as each function lists.
//
// createActions({ llm, nowPlaying, imageSearch, sendCommand, console })

const { musicAck } = require('./commands');
const { claimsMusic, MUSIC_FOLLOWUP } = require('./llm-tools');

function createActions({ llm, nowPlaying = null, imageSearch = null, sendCommand, console }) {
  const music = () => !!nowPlaying?.enabled;

  // ctx: { channel, guildId, userId }
  async function musicCommand(what, { channel, guildId = '', userId }) {
    // Whether something is already playing, asked before the command changes
    // it: "Adding … to the queue" rather than "playing" then.
    const np = what.command.queuedAck && music() ? await nowPlaying.get(guildId) : null;
    await sendCommand(channel, what.command, userId);
    return musicAck(what.command, np) || '';
  }

  // ctx: { guildId, userId }
  async function fixedAnswer(what, { guildId = '', userId }) {
    if (!music()) return null;
    if (what.type === 'now-playing') return nowPlaying.describe(await nowPlaying.get(guildId));
    if (what.type === 'top-songs') {
      return what.mine
        ? nowPlaying.describeRequests(await nowPlaying.topRequests(userId, what.count), what.count)
        : nowPlaying.describeTop(await nowPlaying.topSongs(what.count), what.count);
    }
    return null;
  }

  // ctx: { channel, userId,
  //        onPicture(promise, query)  a picture is being found (resolves to it, or null)
  //        onSay(text)                say this in the voice channel (text chat)
  //        onLeave()                  leave after the reply (voice)
  //        onOther(t)                 anything else: searches and their results }
  function toolHandler({ channel, userId, onPicture = () => {}, onSay = () => {}, onLeave = () => {}, onOther = () => {} }) {
    let musicCalled = false;
    const onTool = t => {
      if (t.type === 'music') {
        musicCalled = true;
        if (t.command) sendCommand(channel, t.command, userId);
      } else if (t.type === 'image') {
        if (imageSearch && t.query) onPicture(imageSearch.find(t.query), t.query);
      } else if (t.type === 'say') {
        onSay(t.text);
      } else if (t.type === 'leave') {
        onLeave();
      } else {
        onOther(t);
      }
    };
    return { onTool, musicCalled: () => musicCalled };
  }

  // ctx: { answer, musicCalled, channel, userId, log (the log prefix),
  //        stream (llm.stream options for the follow-up), stop() → true to stop }
  // Resolves to the number of music calls made (0 also when it didn't run).
  async function musicFollowUp({ answer, musicCalled, channel, userId, log, stream, stop = () => false }) {
    if (musicCalled || !String(answer || '').trim() || !llm.canUseTools?.() || !claimsMusic(answer)) return 0;
    console.warn(`${log} said music was queued but called no music tool — asking it to make the calls`);
    let calls = 0;
    const onTool = t => {
      if (t.type !== 'music') return;
      calls++;
      if (t.command) sendCommand(channel, t.command, userId);
    };
    try {
      for await (const _ of llm.stream(MUSIC_FOLLOWUP, { ...stream, userId, useSearch: false, onTool })) {
        if (stop()) break;   // its words are never said or posted
      }
    } catch (err) {
      if (!stop()) console.warn(`${log} music follow-up failed: ${err.message}`);
    }
    console.log(`${log} music follow-up: ${calls ? `${calls} music call(s) made` : 'no calls (no music meant)'}`);
    return calls;
  }

  return { musicCommand, fixedAnswer, toolHandler, musicFollowUp };
}

module.exports = { createActions };
