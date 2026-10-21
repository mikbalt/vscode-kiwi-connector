import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissingVariableError, substitute } from '../template';

test('substitutes known variables and env, keeps unknown ones', () => {
  const out = substitute('run --run ${runId} --case ${caseId} ${HOME} ${env:FOO}', { runId: '4', caseId: '12' }, { env: { FOO: 'bar' } });
  assert.equal(out, 'run --run 4 --case 12 ${HOME} bar');
});

test('throws for known but unavailable variables', () => {
  assert.throws(
    () => substitute('pytest ${file}', { file: undefined }),
    (err: unknown) => err instanceof MissingVariableError && err.variable === 'file',
  );
});

test('lenient mode replaces unavailable variables with empty strings', () => {
  assert.equal(substitute('${workspaceFolder}/x', { workspaceFolder: undefined }, { lenient: true }), '/x');
});
