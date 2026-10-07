// Reading the files run.js writes, for rate.js and report.js.

const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DIR = path.join(__dirname, 'results');
const RATINGS = path.join(DIR, 'ratings.json');

// The named files, or every run in bench/results, oldest first.
function loadResults(files = []) {
  if (!files.length) {
    files = fs.existsSync(DIR)
      ? fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'ratings.json').map(f => path.join(DIR, f))
      : [];
  }
  if (!files.length) { console.error('No results yet — run node bench/run.js first'); process.exit(1); }
  return files.map(f => ({ file: f, ...JSON.parse(fs.readFileSync(f, 'utf8')) }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function ratingKey(id, answer) {
  return crypto.createHash('sha1').update(`${id}\n${answer}`).digest('hex').slice(0, 16);
}

module.exports = { loadResults, ratingKey, RATINGS, DIR };
