// Settings (config.js): parsing, checking, warnings — and that the README and
// example.env stay in step with the list of settings.
// Run: node --test test/   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { loadConfig, parseWaits, SETTINGS, OTHER_PROGRAMS } = require('../config');

// A fresh env object each time, so each call reports its own warnings.
function load(env) {
  const warnings = [];
  const config = loadConfig({ ...env }, { warn: m => warnings.push(m) });
  return { config, warnings };
}

describe('defaults', () => {
  it('an empty environment gives every setting its default, with no warnings', () => {
    const { config, warnings } = load({});
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(config.OWW_THRESHOLD, 0.5);
    assert.strictEqual(config.OWW_ENABLED, true);
    assert.strictEqual(config.QWEN3_TTS_STREAM, false);
    assert.strictEqual(config.WEB_SEARCH, 'always');
    assert.deepStrictEqual(config.IGNORED_USER_IDS, []);
    assert.strictEqual(config.KOKORO_URL, '');
    assert.strictEqual(config.LUNA_TIMEZONE, 'UTC');
    assert.ok(Object.isFrozen(config));
    assert.strictEqual(Object.keys(config).length, SETTINGS.length);
  });
  it('blank values count as unset', () => {
    assert.strictEqual(load({ OWW_THRESHOLD: '  ' }).config.OWW_THRESHOLD, 0.5);
  });
  it('LUNA_TIMEZONE falls back to TZ', () => {
    assert.strictEqual(load({ TZ: 'Europe/Paris' }).config.LUNA_TIMEZONE, 'Europe/Paris');
    assert.strictEqual(load({ TZ: 'Europe/Paris', LUNA_TIMEZONE: 'Asia/Tokyo' }).config.LUNA_TIMEZONE, 'Asia/Tokyo');
  });
});

describe('parsing', () => {
  it('numbers, on/off, choices, lists and phrases', () => {
    const { config, warnings } = load({
      OWW_THRESHOLD: '0.35', SILENCE_MS: ' 700 ', OWW_ENABLED: 'no', ANNOUNCE_SELF: 'OFF', QWEN3_TTS_STREAM: '1',
      WEB_SEARCH: 'Keywords', IGNORED_USER_IDS: ' 1 , 2,, 3 ', FAREWELL_PHRASES: '{name} left. | Bye, {name}! |',
    });
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(config.OWW_THRESHOLD, 0.35); assert.strictEqual(config.SILENCE_MS, 700);
    assert.strictEqual(config.OWW_ENABLED, false); assert.strictEqual(config.ANNOUNCE_SELF, false); assert.strictEqual(config.QWEN3_TTS_STREAM, true);
    assert.strictEqual(config.WEB_SEARCH, 'keywords');
    assert.deepStrictEqual(config.IGNORED_USER_IDS, ['1', '2', '3']);
    assert.deepStrictEqual(config.FAREWELL_PHRASES, ['{name} left.', 'Bye, {name}!']);
  });
  it('THINKING_WAITS windows', () => {
    assert.deepStrictEqual(parseWaits('15-22,30'), [[15000, 22000], [30000, 30000]]);
    assert.strictEqual(parseWaits('soon-ish'), null);
  });
});

describe('invalid values', () => {
  const cases = [
    ['OWW_THRESHOLD', 'abc', 'expected a number', 0.5],
    ['OWW_THRESHOLD', '1.5', 'expected at most 1', 0.5],
    ['SILENCE_MS', '700.5', 'expected a whole number', 1000],
    ['TTS_LOOKAHEAD', '0', 'expected at least 1', 2],
    ['GREET_ON_JOIN', 'sometimes', 'expected true or false', true],
    ['WEB_SEARCH', 'sometimes', 'expected one of always, keywords, off', 'always'],
    ['OWW_GAIN', 'loud', 'expected auto, off or a number above 0', 'auto'],
    ['THINKING_WAITS', 'soon-ish', 'expected windows in seconds', '15-22,22-30,30-40'],
  ];
  for (const [name, raw, problem, fallback] of cases) {
    it(`${name}=${raw} → warning, default ${JSON.stringify(fallback)}`, () => {
      const { config, warnings } = load({ [name]: raw });
      assert.strictEqual(config[name], fallback);
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].startsWith(`[config] ${name}=${JSON.stringify(raw)} is invalid (${problem}`), warnings[0]);
    });
  }
  it('a secret is never shown in a warning', () => {
    // Secrets are free text, so they can't be invalid; check the output never contains one.
    const { warnings } = load({ DISCORD_TOKEN: 'super-secret-value', OWW_THRESHHOLD: '1' });
    assert.ok(!warnings.join('\n').includes('super-secret-value'));
  });
  it('each problem is reported once per environment, however often it is loaded', () => {
    const env = { OWW_THRESHOLD: 'abc' }, warnings = [];
    for (let i = 0; i < 3; i++) loadConfig(env, { warn: m => warnings.push(m) });
    assert.strictEqual(warnings.length, 1);
  });
});

describe('unknown names', () => {
  it('a misspelled Luna setting is reported with the closest real name', () => {
    const { warnings } = load({ OWW_THRESHHOLD: '0.3', TTS_PROVDER: 'qwen3' });
    assert.ok(warnings.includes("[config] OWW_THRESHHOLD is not one of Luna's settings and is ignored — did you mean OWW_THRESHOLD?"), warnings.join('\n'));
    assert.ok(warnings.some(w => /TTS_PROVDER .* did you mean TTS_PROVIDER\?/.test(w)));
  });
  it('other programs\' settings and unrelated environment variables are not reported', () => {
    const { warnings } = load({ KOKORO_THREADS: '4', WHISPER_THREADS: '8', QWEN3_TTS_TEMPERATURE: '0.3',
      PATH: '/usr/bin', HOME: '/root', NODE_VERSION: '22', HOSTNAME: 'luna' });
    assert.deepStrictEqual(warnings, []);
  });
});

describe('documentation stays in step', () => {
  const ROOT = path.join(__dirname, '..', '..', '..');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const example = fs.readFileSync(path.join(__dirname, '..', 'example.env'), 'utf8');
  const names = SETTINGS.map(s => s.name);

  it('every setting is documented in the README', () => {
    const missing = names.filter(n => !new RegExp(`\\b${n}\\b`).test(readme));
    assert.deepStrictEqual(missing, [], 'add these to the README configuration tables');
  });
  it('example.env only mentions real settings', () => {
    const mentioned = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]);
    assert.deepStrictEqual(mentioned.filter(n => !names.includes(n) && !OTHER_PROGRAMS.has(n)), []);
  });
  it('setting names are unique', () => assert.strictEqual(new Set(names).size, names.length));
});
