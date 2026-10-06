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
//   - markdown is removed (see speakable): the model is told not to use it,
//     but searched answers still come back with **bold** and lists, and TTS
//     would read the asterisks or stumble on them;
//   - text with no letters or digits ("." on its own) is ignored.
//
// The normal order — search, reasoning, answer — never holds anything, so
// ordinary answers are not delayed.

const THINK_TAG     = /<\/?think>/i;
const THINK_TAG_ALL = /<\/?think>/gi;
// A tool call written out as text (Qwen's <tool_call> / <function=...> format).
const FAKE_TOOL_CALL = /<\/?tool_call>|<function[=\s>]|<\/function>/i;

const hasWords = text => /[\p{L}\p{N}]/u.test(text);

// Markdown → plain speech. Formatting markers go, their text stays:
//   **bold** __bold__ *italic* _italic_ `code`  →  bold bold italic italic code
//   [text](https://…)                           →  text
//   "# Heading", "- item", "1. item", "> quote" at the start of a line → marker gone
// plus any leftover ** or __ (a sentence can split inside a bold phrase).
// Untouched: ElevenLabs audio tags like [laughs] (no "(url)" after them) and
// underscores inside words (snake_case).
function stripMarkdown(text) {
  return text
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/\*{2,}|_{2,}|`+/g, '');
}

// What TTS gets: no reasoning tags, no markdown, single spaces.
const speakable = text => stripMarkdown(text.replace(THINK_TAG_ALL, ' ')).replace(/\s+/g, ' ').trim();

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
  const say = raw => {
    const sentence = speakable(raw);
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
          discard('leaked reasoning', [speakable(closing[1])]);
          state = resting;
          say(closing[2]);
          return 'ok';
        }
        const opening = sentence.match(/^([\s\S]*?)<think>([\s\S]*)$/i);
        if (opening && reasoning) {
          say(opening[1]);
          state = 'unsure';
          say(opening[2]);
          return 'ok';
        }
        say(sentence);
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

module.exports = { createAnswerFilter, stripMarkdown, FAKE_TOOL_CALL };
