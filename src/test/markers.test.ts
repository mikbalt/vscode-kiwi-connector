import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilePatterns, findMarkers, globToRegExp } from '../mapping/markers';

const DEFAULTS = [
  String.raw`\bkiwi\(([\d,\s]+)\)`,
  String.raw`\bkiwi\s*[:=]\s*#?((?:\d+\s*,\s*)*\d+)`,
  String.raw`\b(?:TC|KIWI)-(\d+)\b`,
];

const ids = (text: string) => findMarkers(text, compilePatterns(DEFAULTS).regexes).map((m) => m.caseId);

test('default patterns find common marker styles', () => {
  assert.deepEqual(ids('# kiwi: 12'), [12]);
  assert.deepEqual(ids('// Kiwi=7'), [7]);
  assert.deepEqual(ids('@pytest.mark.kiwi(3, 4)'), [3, 4]);
  assert.deepEqual(ids('@Kiwi(99)'), [99]);
  assert.deepEqual(ids('    [Tags]    smoke    TC-55'), [55]);
  assert.deepEqual(ids("test('KIWI-8 logs in', () => {})"), [8]);
  assert.deepEqual(ids('# kiwi: 1, 2,3'), [1, 2, 3]);
});

test('positions are reported per line and duplicates on one line are merged', () => {
  const text = 'line0\n  # kiwi: 5 TC-5\n\nTC-6';
  const found = findMarkers(text, compilePatterns(DEFAULTS).regexes);
  assert.deepEqual(
    found.map((m) => [m.caseId, m.line, m.character]),
    [
      [5, 1, 4],
      [6, 3, 0],
    ],
  );
});

test('no false positives on unrelated text', () => {
  assert.deepEqual(ids('kiwi-vscode ATC-12x tc_12 kiwifruit(1'), []);
});

test('invalid or group-less patterns are reported', () => {
  const { regexes, errors } = compilePatterns(['(', 'TC-\\d+', 'ok-(\\d+)']);
  assert.equal(regexes.length, 1);
  assert.equal(errors.length, 2);
});

test('globToRegExp handles **, * and braces', () => {
  const include = globToRegExp('**/*.{py,robot}', false);
  assert.ok(include.test('tests/test_a.py'));
  assert.ok(include.test('a.robot'));
  assert.ok(!include.test('a.pyc'));
  const exclude = globToRegExp('**/{node_modules,.venv}/**', false);
  assert.ok(exclude.test('node_modules/x/y.js'));
  assert.ok(exclude.test('pkg/.venv/lib/a.py'));
  assert.ok(!exclude.test('src/venv_tools.py'));
});
