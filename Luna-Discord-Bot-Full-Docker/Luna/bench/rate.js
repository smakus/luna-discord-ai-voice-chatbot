// ─── LLM benchmark: personality ratings ───────────────────────────────────────
//
// Shows the answers to the personality questions one at a time, shuffled and
// without saying which model or mode wrote them, and asks for a 1–5 score:
// does it sound like Luna (LM_PERSONALITY in .env), and would it be nice to
// hear out loud? Scores are kept in bench/results/ratings.json, keyed by the
// answer itself, so an answer is rated once however many runs share it and
// you can stop (q) and pick up later.
//
//   node bench/rate.js [results files…]     (default: every run in bench/results)

const fs = require('fs'), path = require('path'), readline = require('readline');
const { loadResults, ratingKey, RATINGS } = require('./results');

async function main() {
  const results = loadResults(process.argv.slice(2));
  const { questions } = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  const personal = new Map(questions.filter(q => q.personality).map(q => [q.id, q]));
  const ratings = fs.existsSync(RATINGS) ? JSON.parse(fs.readFileSync(RATINGS, 'utf8')) : {};

  const todo = new Map();
  for (const r of results) {
    for (const run of r.runs) {
      if (!personal.has(run.id) || !run.answer || run.error) continue;
      const key = ratingKey(run.id, run.answer);
      if (!(key in ratings)) todo.set(key, run);
    }
  }
  const queue = [...todo.entries()];
  for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
  if (!queue.length) { console.log('Nothing left to rate.'); return; }

  const traits = results.at(-1)?.personality;
  console.log(`${queue.length} answers to rate. Luna should sound: ${traits}.\n` +
    '1 = wrong for Luna or unpleasant to hear … 5 = exactly her. s = skip, q = quit (progress is saved).\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = text => new Promise(resolve => rl.question(text, resolve));
  let done = 0;
  for (const [key, run] of queue) {
    console.log(`── ${done + 1}/${queue.length} ── "${personal.get(run.id).q}"\n\n${run.answer}\n`);
    let reply;
    while (!/^[1-5sq]$/.test(reply = (await ask('score> ')).trim().toLowerCase())) console.log('1–5, s or q');
    if (reply === 'q') break;
    if (reply !== 's') {
      ratings[key] = Number(reply);
      fs.writeFileSync(RATINGS, JSON.stringify(ratings, null, 1));
    }
    done++;
    console.log();
  }
  rl.close();
  console.log(`Rated ${Object.keys(ratings).length} answers in all. Next: node bench/report.js`);
}

main().catch(err => { console.error(err); process.exit(1); });
