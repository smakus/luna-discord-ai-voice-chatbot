// ─── Whether to ask the LLM again ─────────────────────────────────────────────
//
// A spoken answer is one LLM request per pass (voice-answer.js), and at most
// one retry for each reason:
//   - search    the model wrote a tool call as text because it was not offered
//               the search tool → ask again with search on (same reasoning);
//   - quick     it thought past LLM_THINK_LIMIT_MS without starting an answer,
//               or finished with no words at all (it has answered "." after
//               50 s of reasoning) → ask again with reasoning off, which
//               answers in seconds;
//   - fresh     otherwise, the answer broke down (a tool call written as text,
//               or nothing said after its search) → forget this person's
//               conversation and ask once more in a fresh one, with the search
//               results already found. Seen live: twelve messages deep, after
//               searches, Qwen wrote '[play_music] "smooth jazz…"' instead of
//               answering, and every later question in that conversation built
//               on the mess; the same question in a fresh conversation was
//               answered correctly.
//   - done      answered, or nothing left to try. If it still broke down, Luna
//               says "Sorry, I lost my train of thought."
//
// nextPass(pass) → { step: 'search' | 'quick' | 'fresh' | 'done', brokeDown }
// pass: what the last pass did, and what has been tried:
//   answered          something was said (in any pass)
//   fakeToolCall      it wrote a tool call as text
//   thinkLimitHit     it was stopped for reasoning too long
//   searched          it searched in this pass
//   saidAfterSearch   sentences said after its search
//   useSearch         search was offered in this pass
//   canSearch         search can be offered at all
//   reasoningOff      this pass had reasoning off
//   reasoningRetried  the quick (reasoning-off) retry has been used
//   freshRetried      the fresh-conversation retry has been used

function nextPass({ answered, fakeToolCall, thinkLimitHit, searched, saidAfterSearch, useSearch, canSearch,
                    reasoningOff, reasoningRetried, freshRetried }) {
  // (Not after the fresh retry: it turned search off on purpose, with the results.)
  if (fakeToolCall && !useSearch && !freshRetried && canSearch) return { step: 'search', brokeDown: false };
  const brokeDown = !thinkLimitHit && (fakeToolCall || !answered || (searched && saidAfterSearch === 0));
  if (answered || reasoningOff || reasoningRetried) {
    // The reasoning retry can't help: a fresh conversation, once.
    if (!brokeDown || freshRetried || reasoningRetried) return { step: 'done', brokeDown };
    return { step: 'fresh', brokeDown };
  }
  return { step: 'quick', brokeDown };
}

module.exports = { nextPass };
