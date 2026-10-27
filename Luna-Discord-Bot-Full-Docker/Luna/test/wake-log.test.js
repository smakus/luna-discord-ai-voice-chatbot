// The wake-word log (wake-log.js), with a fake filesystem.
// Run: node --test test/   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const { createWakeLog } = require('../wake-log');

function rig({ file = 'logs/wake.jsonl', maxMb = 1, startSize = 0, failWith = null } = {}) {
  const S = { lines: [], renames: [], dirs: [], warnings: [], size: startSize };
  const fs = {
    mkdir: async (dir, opts) => { S.dirs.push([dir, opts]); },
    stat: async () => (S.size ? { size: S.size } : Promise.reject(new Error('ENOENT'))),
    rename: async (from, to) => { S.renames.push([from, to]); S.lines = []; },
    appendFile: async (f, line) => { if (failWith) throw new Error(failWith); S.lines.push(JSON.parse(line)); S.file = f; },
  };
  const log = createWakeLog({ config: { WAKE_LOG_FILE: file, WAKE_LOG_MAX_MB: maxMb }, fs, path,
    console: { warn: m => S.warnings.push(m) }, nameOf: id => ({ u1: 'smakus' })[id] || id });
  const settle = () => new Promise(r => setTimeout(r, 20));
  return { S, log, settle };
}

describe('wake-word log', () => {
  it('one JSON line per event: time, event, name, ID, fields (scores to 3 decimals)', async () => {
    const { S, log, settle } = rig();
    log.record('discarded', 'u1', { peak: 0.0123456, ms: 1840 });
    log.record('missed', 'u2', { peak: 0.004, answered: 'yes' });
    await settle();
    assert.deepStrictEqual(S.dirs, [['logs', { recursive: true }]]);
    assert.strictEqual(S.file, 'logs/wake.jsonl');
    assert.deepStrictEqual(S.lines.map(({ t, ...rest }) => rest), [
      { event: 'discarded', who: 'smakus', id: 'u1', peak: 0.012, ms: 1840 },
      { event: 'missed', who: 'u2', id: 'u2', peak: 0.004, answered: 'yes' },
    ]);
    assert.ok(!Number.isNaN(Date.parse(S.lines[0].t)));
  });
  it('past WAKE_LOG_MAX_MB → renamed to .1 and started again', async () => {
    const { S, log, settle } = rig({ startSize: 1024 * 1024 - 10 });
    log.record('detected', 'u1', { score: 0.9 });
    await settle();
    assert.deepStrictEqual(S.renames, [['logs/wake.jsonl', 'logs/wake.jsonl.1']]);
    assert.strictEqual(S.lines.length, 1);
  });
  it("can't write → warned once, then off", async () => {
    const { S, log, settle } = rig({ failWith: 'EROFS: read-only file system' });
    log.record('detected', 'u1'); log.record('detected', 'u1'); await settle(); log.record('detected', 'u1'); await settle();
    assert.strictEqual(S.warnings.length, 1);
    assert.match(S.warnings[0], /\[wake-log\] can't write logs\/wake\.jsonl \(EROFS: read-only file system\) — the wake-word log is off/);
  });
  it('WAKE_LOG_FILE empty → nothing written', async () => {
    const { S, log, settle } = rig({ file: '' });
    log.record('detected', 'u1'); await settle();
    assert.deepStrictEqual([S.lines.length, S.dirs.length], [0, 0]);
  });
});

describe('summarizeWakeEvents', () => {
  const { summarizeWakeEvents } = require('../wake-log');
  it('nothing → says so', () => assert.strictEqual(summarizeWakeEvents([]), 'No wake-word events in that time.'));
  it('only chatter (discarded) → nobody listed', () =>
    assert.strictEqual(summarizeWakeEvents([{ event: 'discarded', id: 'u1', who: 'x', peak: 0.01 }]), 'No wake-word events in that time.'));
  it('one "hey Luna", singular', () =>
    assert.strictEqual(summarizeWakeEvents([{ event: 'detected', id: 'u1', who: 'smakus', score: 0.5 }]),
      '• **smakus** — answered 1 of 1 "hey Luna" (model 1). Typical model score 0.50.'));
});
