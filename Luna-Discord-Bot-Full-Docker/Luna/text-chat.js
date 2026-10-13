// ─── Text chat ────────────────────────────────────────────────────────────────
//
// The pure parts of talking to Luna by typing (see "Text chat" in index.js):
// whether a message is addressed to her, and cutting a long answer into
// messages Discord accepts.

// "Luna, …", "hey Luna …", "Luna: …" at the start ("lunar" does not count).
const NAME_RE = /^\s*(?:(?:hey|hi|hello|ok(?:ay)?|yo)[\s,]+)?luna\b[\s,:;.!?-]*/i;

// The question in `content`, or null when the message isn't for her: it must
// @mention her (anywhere) or start with her name. Text commands (!luna …) are
// not questions.
function textQuestion(content, botId, command = '!luna') {
  const text = String(content || '').trim();
  if (!text || text.toLowerCase().startsWith(command)) return null;
  const mention = new RegExp(`<@!?${botId}>`, 'g');
  if (mention.test(text)) {
    const question = text.replace(mention, ' ').replace(/\s+/g, ' ').replace(NAME_RE, '').trim();
    return question || null;
  }
  if (!NAME_RE.test(text)) return null;
  return text.replace(NAME_RE, '').trim() || null;
}

// A request to say something out loud in the voice channel: "say hello in
// Chinese in the voice channel", "tell everyone in vc dinner is ready",
// "announce in voice that …". Handled without relying on the model to call a
// tool (some models answer "I said it!" without calling it).
const SAY_RE = /\b(?:say|tell|announce|speak|shout|whisper|read)\b[\s\S]*?\b(?:in|on|over|to|into)\s+(?:the\s+)?(?:voice(?:\s+(?:channel|chat|call))?|vc|audio(?:\s+channel)?|call)\b/i;
const isSayRequest = question => SAY_RE.test(String(question || ''));

// Discord's limit is 2,000 characters a message. Cut at a paragraph, then a
// line, then a sentence, then a space — whichever comes last within the limit.
function splitMessage(text, max = 2000) {
  const parts = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.search(/[.!?]\s[^.!?]*$/) + 1, window.lastIndexOf(' ')]
      .find(i => i > max * 0.5) || max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = { textQuestion, splitMessage, isSayRequest, NAME_RE };
