import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LineSplitter, RotatingLog, bootMessage } from './logging.ts';

test('RotatingLog: creates the directory, appends, rotates past maxBytes and keeps N generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-desktop-log-'));
  try {
    const path = join(dir, 'logs', 'server.log');
    const log = new RotatingLog(path, { maxBytes: 20, keep: 2 });
    log.write('0123456789\n'); // 11 bytes
    log.write('abcdefghi\n'); // 21 > 20 → rotate before writing
    assert.equal(readFileSync(path, 'utf8'), 'abcdefghi\n');
    assert.equal(readFileSync(`${path}.1`, 'utf8'), '0123456789\n');
    log.write('second-generation-line\n'); // 10 + 23 > 20 → rotates again
    assert.equal(readFileSync(path, 'utf8'), 'second-generation-line\n');
    assert.equal(readFileSync(`${path}.1`, 'utf8'), 'abcdefghi\n');
    assert.equal(readFileSync(`${path}.2`, 'utf8'), '0123456789\n');
    log.write('third\n'); // 23 + 6 > 20 → one more rotation drops the oldest
    assert.equal(readFileSync(path, 'utf8'), 'third\n');
    assert.equal(readFileSync(`${path}.1`, 'utf8'), 'second-generation-line\n');
    assert.equal(readFileSync(`${path}.2`, 'utf8'), 'abcdefghi\n');
    assert.equal(existsSync(`${path}.3`), false);
    log.close();
    log.write('after close'); // silently dropped, never throws
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RotatingLog: reopening an existing file continues from its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-desktop-log-'));
  try {
    const path = join(dir, 'server.log');
    const first = new RotatingLog(path, { maxBytes: 20 });
    first.write('0123456789\n');
    first.close();
    const second = new RotatingLog(path, { maxBytes: 20 });
    second.write('0123456789\n'); // 22 bytes total → rotated, not appended past the limit
    second.close();
    assert.equal(readFileSync(path, 'utf8'), '0123456789\n');
    assert.equal(readFileSync(`${path}.1`, 'utf8'), '0123456789\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootMessage: pino msg, raw text, blank', () => {
  assert.equal(bootMessage('{"level":30,"time":1,"msg":"Server listening at http://127.0.0.1:8080"}'), 'Server listening at http://127.0.0.1:8080');
  assert.equal(bootMessage('{"level":30,"time":1}'), '{"level":30,"time":1}');
  assert.equal(bootMessage('  Error: boom  '), 'Error: boom');
  assert.equal(bootMessage('{not json'), '{not json');
  assert.equal(bootMessage('   '), null);
});

test('LineSplitter: reassembles lines across chunks, CRLF included', () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push('a\nb'), ['a']);
  assert.deepEqual(splitter.push('c\r\nd\n'), ['bc', 'd']);
  assert.deepEqual(splitter.push(Buffer.from('tail')), []);
  assert.deepEqual(splitter.flush(), ['tail']);
  assert.deepEqual(splitter.flush(), []);
});
