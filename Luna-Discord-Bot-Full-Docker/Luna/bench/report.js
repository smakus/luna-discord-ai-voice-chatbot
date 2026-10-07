// ─── LLM benchmark: report ────────────────────────────────────────────────────
//
// One row per model (its latest run; --all combines every run of a model),
// as a Markdown table, followed by what went wrong per model.
//
//   node bench/report.js [--all] [results files…]
//
// Columns (reasoning off unless the model can't turn it off — see Mode):
//   First word   median seconds until the first spoken word — what Luna's
//                listeners wait through
//   Total        median seconds for the whole answer
//   Tok/s        median writing speed
//   Accuracy     answers matching the answer key, and searching when the
//                question needs it (and not when it doesn't)
//   Voice        answers fit to read aloud: no markdown, lists, emoji, links,
//                leaked reasoning, follow-up question or rambling
//   Personality  mean blind rating 1–5 (rate.js), with how many were rated
//   Thinking     with reasoning on: extra seconds before the first word (mean
//                over questions), and the change in accuracy

const { loadResults, ratingKey, RATINGS } = require('./results');
const { summarize, scoreRun } = require('./score');
const fs = require('fs'), path = require('path');

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const results = loadResults(argv.filter(a => a !== '--all'));
  const ratings = fs.existsSync(RATINGS) ? JSON.parse(fs.readFileSync(RATINGS, 'utf8')) : {};
  // Saved answers are scored again, so a fix to the scoring or the answer
  // keys applies to earlier runs too.
  const { questions } = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  const byId = new Map(questions.map(q => [q.id, q]));
  for (const r of results) {
    for (const run of r.runs) Object.assign(run, scoreRun(run, byId.get(run.id), { timeZone: r.timeZone, now: new Date(run.at ?? r.startedAt) }));
  }
  const ratingOf = run => run.answer ? ratings[ratingKey(run.id, run.answer)] : undefined;

  // Latest result per model, unless --all.
  const byModel = new Map();
  for (const r of results) {
    const earlier = byModel.get(r.model);
    byModel.set(r.model, { ...r, runs: all && earlier ? [...earlier.runs, ...r.runs] : r.runs });
  }

  const sec = s => s == null ? '—' : `${s.toFixed(1)} s`;
  const pct = p => p == null ? '—' : `${Math.round(p * 100)}%`;
  const signed = (v, f) => v == null ? '' : (v >= 0 ? '+' : '−') + f(Math.abs(v));
  const rows = [['Model', 'Mode', 'First word', 'Total', 'Tok/s', 'Accuracy', 'Voice', 'Personality', 'Thinking: delay', 'Thinking: accuracy']];
  const problems = [];
  for (const [model, r] of byModel) {
    const s = summarize(r.runs, ratingOf);
    rows.push([
      model, s.mode, sec(s.firstWord), sec(s.total), s.tokPerS == null ? '—' : s.tokPerS.toFixed(0),
      pct(s.accuracy), pct(s.voice),
      s.personality == null ? '—' : `${s.personality.toFixed(1)} (${s.rated})`,
      s.thinking ? signed(s.thinking.delay, sec) || '—' : 'n/a',
      s.thinking ? signed(s.thinking.accuracy, v => `${Math.round(v * 100)} pts`) || '—' : 'n/a',
    ]);
    problems.push(`\n${model} (${r.runs.length} answers${s.errors ? `, ${s.errors} failed` : ''})`);
    const counts = new Map();
    for (const run of r.runs) {
      const marks = [run.error ? 'failed' : null, run.correct === false && !run.error ? 'wrong' : null,
        run.searchOk === false && !run.error ? 'search rule' : null, ...run.voiceIssues.filter(i => i !== 'error')].filter(Boolean);
      for (const m of marks) {
        const key = `${run.id} (${run.mode}): ${m}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    if (!counts.size) problems.push('  no problems');
    for (const [key, n] of [...counts].sort()) problems.push(`  ${key}${n > 1 ? ` ×${n}` : ''}`);
  }

  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => String(row[i]).length)));
  const line = row => '| ' + row.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  console.log([line(rows[0]), '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|', ...rows.slice(1).map(line)].join('\n'));
  console.log(problems.join('\n'));
  const personal = new Set(questions.filter(q => q.personality).map(q => q.id));
  const unrated = [...byModel.values()].some(r => r.runs.some(run => personal.has(run.id) && run.answer && !run.error && ratingOf(run) === undefined));
  if (unrated) console.log('\nSome answers have no personality rating yet — node bench/rate.js');
}

main();
