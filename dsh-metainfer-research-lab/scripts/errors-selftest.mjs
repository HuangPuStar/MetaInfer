/** U10: rejected actions must carry an executable next step, not a bare code. */
import assert from 'node:assert/strict';
import { NEXT_STEPS, toActionable } from '../host/kernel/errors.js';
import { LabError } from '../host/git-engine.js';
import { validateModelSelection } from '../host/models.js';

let failed = 0;
function check(label, fn) {
  try { fn(); process.stdout.write(`ok   ${label}\n`); }
  catch (error) { failed += 1; process.stdout.write(`FAIL ${label}: ${error?.message ?? error}\n`); }
}

for (const code of ['forbidden_action', 'model_profile_unknown', 'model_not_allowed', 'model_unresolved', 'dashboard_disabled', 'dashboard_empty', 'unknown_command']) {
  check(`${code} has a specific next step`, () => {
    const next = toActionable({ code, message: 'x' }).error.nextStep;
    assert.ok(next && next !== NEXT_STEPS.error, next);
    assert.ok(next.length > 20);
  });
}

check('model_profile_unknown lists the registered profiles', async () => {
  await assert.rejects(
    () => validateModelSelection(
      { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
      { config: { modelOptions: [{ id: 'fast', provider: 'p', model: 'm' }] } },
      { profileId: 'missing' },
    ),
    (error) => {
      assert.equal(error.code, 'model_profile_unknown');
      assert.match(error.message, /fast/);
      assert.match(error.message, /available profiles/);
      return true;
    },
  );
});

check('unknown command is actionable at the tool boundary', () => {
  const message = toActionable(new LabError('unknown_command', 'unknown action: nope'), { action: 'nope' });
  assert.equal(message.error.code, 'unknown_command');
  assert.match(message.error.nextStep, /action name/i);
});

process.stdout.write(failed === 0 ? '\nerrors-selftest: all checks passed\n' : `\nerrors-selftest: ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
