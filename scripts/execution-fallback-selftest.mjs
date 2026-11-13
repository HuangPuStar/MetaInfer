/**
 * Self-test for execution-profile resolution tolerance.
 *
 * Run from the plugin directory: `node scripts/execution-fallback-selftest.mjs`
 *
 * An advisor proposal that names a profile the project does not define used to
 * be discarded whole ("unknown execution profile: default"), which counted as
 * no progress and starved the auto driver. Selection metadata is not the
 * experiment, so a suggestion path may fall back to the project default; an
 * explicit API call must still fail loudly.
 */
import assert from 'node:assert/strict';
import { resolveExecutionProfile, DEFAULT_EXECUTION_PROFILE } from '../host/execution.js';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

const project = { config: { execution: { profiles: { dsh: { driver: 'dsh' }, codex: { driver: 'codex' } } } } };

await test('a configured profile resolves as requested', () => {
  const resolved = resolveExecutionProfile(project, { executionProfile: 'codex' });
  assert.equal(resolved.profile, 'codex');
  assert.equal(resolved.driver, 'codex');
  assert.equal(resolved.profileFallback, false);
});

await test('omitting the profile uses the default', () => {
  const resolved = resolveExecutionProfile(project, {});
  assert.equal(resolved.profile, DEFAULT_EXECUTION_PROFILE);
  assert.equal(resolved.profileFallback, false);
});

await test('a strict call still rejects an unknown profile', () => {
  assert.throws(
    () => resolveExecutionProfile(project, { executionProfile: 'default' }),
    (error) => error.code === 'bad_request' && /unknown execution profile: default/.test(error.message),
  );
});

await test('a suggestion path falls back to the default and reports it', () => {
  for (const requestedProfile of ['default', 'auto', 'Codex-Nonexistent']) {
    const resolved = resolveExecutionProfile(project, { executionProfile: requestedProfile, fallbackToDefault: true });
    assert.equal(resolved.profile, DEFAULT_EXECUTION_PROFILE, `${requestedProfile} must fall back`);
    assert.equal(resolved.requestedProfile, requestedProfile);
    assert.equal(resolved.profileFallback, true, 'the correction must be visible to the caller');
    assert.equal(resolved.driver, 'dsh');
  }
});

await test('fallback still rejects a malformed profile name', () => {
  // A value that is not a profile name at all is a different failure: the caller
  // is not "suggesting something else", it is sending broken data.
  assert.throws(
    () => resolveExecutionProfile(project, { executionProfile: 'not a name!', fallbackToDefault: true }),
    (error) => error.code === 'bad_request',
  );
});

await test('a taskType mapping still wins over the default', () => {
  const mapped = {
    config: {
      execution: {
        profiles: { dsh: { driver: 'dsh' }, codex: { driver: 'codex' } },
        taskTypes: { review: 'codex' },
      },
    },
  };
  const resolved = resolveExecutionProfile(mapped, { taskType: 'review' });
  assert.equal(resolved.profile, 'codex');
  assert.equal(resolved.taskType, 'review');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} execution fallback self-test(s) failed`);
  process.exit(1);
}
console.log('\nexecution fallback self-test passed');
