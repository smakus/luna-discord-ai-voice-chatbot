// ─── Answer filter ────────────────────────────────────────────────────────────
//
// Decides which parts of the LLM's streamed answer Luna says out loud. It sees
// LM Studio's stream events (event) and the answer text sentence by sentence
// (text), and for each sentence either speaks it now, holds it, or drops it.
//
// Why anything is held or dropped at all: the model sometimes puts its own
// planning into the visible answer, and every visible sentence goes straight
// to TTS. Three known shapes:
//
//   narration      "I'll search for that." / "The results were irrelevant,
//                  let me try again." — text written just before a search.
//   leaked         after a search the model is meant to reason (LM Studio
//   reasoning      sends reasoning.start) and then answer; sometimes it does
//                  that thinking in the visible text and ends it with
//                  "</think>". Luna once spoke a draft answer, the tag, then
//                  the answer again.
//   tool call      "<tool_call><function=…>" — the model wanted a tool it was
//   as text        not offered. Never spoken; the caller retries.
//
// States:
//
//   speaking     sentences are spoken as they arrive (the normal case)
//   holding      everything waits for the end of the answer — used when the
//                model cannot reason (reasoning off) but may search, so any
//                text may turn out to be narration
//   unsure       after a search with no reasoning yet, or after a stray
//                "<think>": text may be reasoning. Held until reasoning.start
//                (it was an answer: spoken) or "</think>" (it was reasoning:
//                dropped) or the end (it was an answer: spoken)
//
// Rules, in any state:
//   - a search starting drops whatever is pending: text written just before
//     a search is narration;
//   - "</think>" drops whatever is pending and the text before the tag;
//   - <think>/</think> tags are never spoken;
//   - text with no letters or digits ("." on its own) is ignored.
//
// The normal order — search, reasoning, answer — never holds anything, so
// ordinary answers are not delayed.

const THINK_TAG     = /<\/?think>/i;
const THINK_TAG_ALL = /<\/?think>/gi;
// A tool call written out as text (Qwen's <tool_call> / <function=...> format).
const FAKE_TOOL_CALL = /<\/?tool_call>|<function[=\s>]|<\/function>/i;

const hasWords = text => /[\p{L}\p{N}]/u.test(text);
const tidy = text => text.replace(THINK_TAG_ALL, ' ').replace(/\s+/g, ' ').trim();

// options:
//   reasoning     false when the model answers without reasoning (reasoning
//                 off): it then has no reasoning to leak, so "unsure" is
//                 never entered
//   holdUntilEnd  start in "holding" (reasoning-off answers that may search)
//   speak(text)   say a sentence
//   drop(kind, text)  a sentence will not be said: 'narration' | 'leaked reasoning'
//
// text(sentence) returns 'ignored' (nothing to say), 'tool-call-as-text' (the
// caller should stop this answer) or 'ok'.
function createAnswerFilter({ reasoning = true, holdUntilEnd = false, speak, drop = () => {} }) {
  const resting = holdUntilEnd ? 'holding' : 'speaking';
  let state = resting;
  let pending = [];

  const release = () => {
    const out = pending;
    pending = [];
    out.forEach(speak);
  };
  const discard = (kind, extra = []) => {
    const lost = [...pending, ...extra].filter(hasWords);
    pending = [];
    if (lost.length) drop(kind, lost.join(' ').replace(/\s+/g, ' '));
  };
  const say = sentence => {
    if (!hasWords(sentence)) return;
    if (state === 'speaking') speak(sentence);
    else pending.push(sentence);
  };

  return {
    get state() { return state; },

    event(e) {
      if (e.type === 'tool_call.start') {
        discard('narration');
      } else if (e.type === 'tool_call.success') {
        if (reasoning && state === 'speaking') state = 'unsure';
      } else if (e.type === 'reasoning.start' && state === 'unsure') {
        // Reasoning was parsed normally after all: what was held is answer.
        state = resting;
        if (state === 'speaking') release();
      }
    },

    text(sentence) {
      if (!hasWords(sentence)) return 'ignored';
      if (FAKE_TOOL_CALL.test(sentence)) return 'tool-call-as-text';

      if (THINK_TAG.test(sentence)) {
        const closing = sentence.match(/^([\s\S]*)<\/think>([\s\S]*)$/i);
        if (closing) {
          discard('leaked reasoning', [tidy(closing[1])]);
          state = resting;
          say(tidy(closing[2]));
          return 'ok';
        }
        const opening = sentence.match(/^([\s\S]*?)<think>([\s\S]*)$/i);
        if (opening && reasoning) {
          say(tidy(opening[1]));
          state = 'unsure';
          say(tidy(opening[2]));
          return 'ok';
        }
        say(tidy(sentence));
        return 'ok';
      }

      say(sentence);
      return 'ok';
    },

    // The answer is complete: anything still held was answer, not narration
    // or reasoning, so say it.
    end() {
      release();
    },
  };
}

module.exports = { createAnswerFilter, FAKE_TOOL_CALL };
