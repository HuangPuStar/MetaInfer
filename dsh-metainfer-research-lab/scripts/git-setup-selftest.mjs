#!/usr/bin/env node
/** Offline Git setup tests. All subprocesses are mocked; nothing is installed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitSetup } from '../host/git-setup.js';

const missing = () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
const gitVersion = { stdout: 'git version 2.47.1.windows.2\n' };
const wingetArgs = ['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

function fixture(run = missing, options = {}) {
  const calls = [];
  const setup = createGitSetup({ subprocess: {
    spawn(spec) {
      calls.push(spec);
      assert.ok(spec.argv.every((arg) => typeof arg === 'string'));
      assert.equal(spec.stdio.stdin, 'ignore');
      assert.ok(spec.stdio.stdout.maxBytes > 0 && spec.stdio.stdout.maxBytes <= 65536);
      assert.ok(spec.stdio.stderr.maxBytes > 0 && spec.stdio.stderr.maxBytes <= 65536);
      assert.ok(spec.signal instanceof AbortSignal);
      assert.equal(spec.shell, undefined);
      const result = run(spec) ?? {};
      return {
        done: result.done ?? (result.error ? Promise.reject(result.error) : Promise.resolve({ exitCode: result.exitCode ?? 0 })),
        collected: {
          stdout: { readFrom: () => ({ text: result.stdout ?? '' }) },
          stderr: { readFrom: () => ({ text: result.stderr ?? '' }) },
        },
      };
    },
  } }, { platform: 'linux', env: {}, uid: 0, probeTimeoutMs: 20, installTimeoutMs: 20, ...options });
  return { setup, calls };
}

function code(expected) {
  return (error) => {
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes('PRIVATE_STDERR'));
    return true;
  };
}

test('PATH Git is verified; status has the exact available shape and no manager probe', async () => {
  const { setup, calls } = fixture(({ argv }) => argv[0] === 'git' ? gitVersion : missing());
  assert.deepEqual(await setup.status(), {
    available: true, version: '2.47.1.windows.2', executable: 'git', platform: 'linux',
    installable: false, manualCommand: 'https://git-scm.com/download/linux',
  });
  assert.equal(await setup.resolveGit(), 'git');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, ['git', '--version']);
});

test('missing Git and missing managers return a manual path, not false success', async () => {
  const { setup } = fixture();
  await assert.rejects(setup.resolveGit(), code('git_missing'));
  assert.deepEqual(await setup.status(), {
    available: false, platform: 'linux', installable: false,
    manualCommand: 'https://git-scm.com/download/linux',
  });
  await assert.rejects(setup.install({ confirmed: true }), code('git_install_unavailable'));
});

test('synchronous spawn ENOENT is classified as missing', async () => {
  const { setup } = fixture(() => { throw missing().error; });
  await assert.rejects(setup.resolveGit(), code('git_missing'));
  assert.equal((await setup.status()).available, false);
});

for (const [env, executable] of [
  [{ ProgramFiles: 'D:\\Apps' }, 'D:\\Apps\\Git\\cmd\\git.exe'],
  [{ PROGRAMW6432: 'D:\\Programs' }, 'D:\\Programs\\Git\\bin\\git.exe'],
  [{ LOCALAPPDATA: 'D:\\User\\Local' }, 'D:\\User\\Local\\Programs\\Git\\cmd\\git.exe'],
  [{ USERPROFILE: 'D:\\User' }, 'D:\\User\\AppData\\Local\\Programs\\Git\\bin\\git.exe'],
  [{}, 'C:\\Program Files\\Git\\cmd\\git.exe'],
]) {
  test(`Windows finds a standard Git outside PATH: ${executable}`, async () => {
    const { setup } = fixture(({ argv }) => argv[0] === executable ? gitVersion : missing(), { platform: 'win32', env });
    assert.equal(await setup.resolveGit(), executable);
    assert.equal((await setup.status()).executable, executable);
  });
}

for (const executable of ['/opt/homebrew/bin/git', '/usr/local/bin/git']) {
  test(`macOS finds Homebrew Git outside PATH: ${executable}`, async () => {
    const { setup } = fixture(({ argv }) => argv[0] === executable ? gitVersion : missing(), { platform: 'darwin' });
    assert.equal(await setup.resolveGit(), executable);
  });
}

for (const result of [
  { exitCode: 128, stderr: 'PRIVATE_STDERR' },
  { stdout: 'not really git' },
  { error: Object.assign(new Error('PRIVATE_STDERR'), { code: 'EACCES' }) },
]) {
  test(`real Git execution errors are not reported as missing: ${result.error?.code ?? result.exitCode ?? 'bad version'}`, async () => {
    const { setup } = fixture(({ argv }) => argv[0] === 'git' ? result : missing());
    await assert.rejects(setup.resolveGit(), code('git_failed'));
    await assert.rejects(setup.status(), code('git_failed'));
    await assert.rejects(setup.install({ confirmed: true }), code('git_install_failed'));
  });
}

test('synchronous non-ENOENT errors remain execution failures', async () => {
  const { setup } = fixture(() => { throw Object.assign(new Error('PRIVATE_STDERR'), { code: 'EPERM' }); });
  await assert.rejects(setup.resolveGit(), code('git_failed'));
});

test('a stalled version check is aborted and remains an execution failure', async () => {
  const { setup, calls } = fixture(({ argv }) => argv[0] === 'git' ? { done: new Promise(() => {}) } : missing());
  await assert.rejects(setup.resolveGit(), code('git_failed'));
  assert.equal(calls[0].signal.aborted, true);
});

test('only successful candidates are cached and cached paths are reverified', async () => {
  let executable;
  const { setup, calls } = fixture(({ argv }) => argv[0] === executable ? gitVersion : missing(), { platform: 'darwin' });
  await assert.rejects(setup.resolveGit(), code('git_missing'));
  executable = '/opt/homebrew/bin/git';
  assert.equal(await setup.resolveGit(), executable);
  calls.length = 0;
  assert.equal(await setup.resolveGit(), executable);
  assert.deepEqual(calls.map((entry) => entry.argv[0]), [executable]);
  executable = '/usr/local/bin/git';
  assert.equal(await setup.resolveGit(), executable);
});

test('confirmation must be literal true and rejection never spawns a process', async () => {
  const { setup, calls } = fixture();
  for (const confirmed of [undefined, false, 1, 'true', {}]) {
    await assert.rejects(setup.install({ confirmed }), code('git_install_confirmation_required'));
  }
  await assert.rejects(setup.install(), code('git_install_confirmation_required'));
  assert.equal(calls.length, 0);
});

test('confirmed install skips an already available Git', async () => {
  const { setup, calls } = fixture(({ argv }) => argv[0] === 'git' ? gitVersion : missing());
  assert.equal((await setup.install({ confirmed: true })).available, true);
  assert.equal(calls.length, 1);
});

test('winget uses fixed argv and rediscovers installed standard paths without PATH changes', async () => {
  let installed = false;
  const executable = 'D:\\Apps\\Git\\cmd\\git.exe';
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === executable && installed) return gitVersion;
    if (argv[0] === 'winget' && argv[1] === '--version') return { stdout: 'v1.9' };
    if (argv[0] === 'winget' && argv[1] === 'install') { installed = true; return {}; }
    return missing();
  }, { platform: 'win32', env: { ProgramFiles: 'D:\\Apps' } });
  const before = await setup.status();
  assert.deepEqual(before, {
    available: false, platform: 'win32', installable: true, manager: 'winget',
    command: ['winget', ...wingetArgs].join(' '), manualCommand: 'https://git-scm.com/download/win',
  });
  const result = await setup.install({ confirmed: true, command: 'do not execute this' });
  assert.equal(result.available, true);
  assert.equal(result.executable, executable);
  assert.equal(result.installable, false);
  assert.deepEqual(calls.filter(({ argv }) => argv[1] === 'install').map(({ argv }) => argv), [['winget', ...wingetArgs]]);
});

test('Windows can discover winget in WindowsApps when PATH is stale', async () => {
  const manager = 'D:\\Local\\Microsoft\\WindowsApps\\winget.exe';
  const { setup } = fixture(({ argv }) => argv[0] === manager ? { stdout: 'v1.9' } : missing(), {
    platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' },
  });
  const status = await setup.status();
  assert.equal(status.manager, 'winget');
  assert.equal(status.command, [manager, ...wingetArgs].join(' '));
});

test('macOS uses Homebrew outside PATH noninteractively and rediscovers Git on PATH', async () => {
  let installed = false;
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === '/usr/bin/which' && installed) return { stdout: '/opt/homebrew/bin/git\n' };
    if (argv[0] === 'git' && installed) return gitVersion;
    if (argv[0] === '/opt/homebrew/bin/brew') {
      if (argv[1] === 'install') installed = true;
      return { stdout: 'Homebrew 4' };
    }
    return missing();
  }, { platform: 'darwin' });
  assert.equal((await setup.status()).command, '/opt/homebrew/bin/brew install git');
  assert.equal((await setup.install({ confirmed: true })).executable, 'git');
  const install = calls.find(({ argv }) => argv[1] === 'install');
  assert.deepEqual(install.argv, ['/opt/homebrew/bin/brew', 'install', 'git']);
  assert.equal(install.env.NONINTERACTIVE, '1');
  assert.equal(install.env.HOMEBREW_NO_AUTO_UPDATE, '1');
});

for (const [manager, args] of [
  ['apt-get', ['install', '-y', 'git']],
  ['dnf', ['install', '-y', 'git']],
  ['yum', ['install', '-y', 'git']],
  ['pacman', ['-S', '--noconfirm', '--needed', 'git']],
  ['zypper', ['--non-interactive', 'install', '--no-recommends', 'git']],
]) {
  test(`Linux root uses fixed ${manager} arguments`, async () => {
    let installed = false;
    const { setup, calls } = fixture(({ argv }) => {
      if (argv[0] === 'git' && installed) return gitVersion;
      if (argv[0] !== manager) return missing();
      if (argv[1] !== '--version') installed = true;
      return {};
    });
    assert.equal((await setup.status()).command, [manager, ...args].join(' '));
    assert.equal((await setup.install({ confirmed: true })).available, true);
    assert.deepEqual(calls.filter(({ argv }) => argv[0] === manager && argv[1] !== '--version').map(({ argv }) => argv), [[manager, ...args]]);
  });
}

test('non-root Linux only uses sudo -n, with ignored stdin and noninteractive apt', async () => {
  let installed = false;
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === 'git' && installed) return gitVersion;
    if (['apt-get', 'sudo'].includes(argv[0]) && argv[1] === '--version') return {};
    if (argv[0] === 'sudo' && argv[1] === '-n') { installed = true; return {}; }
    return missing();
  }, { uid: 1000 });
  assert.equal((await setup.status()).command, 'sudo -n apt-get install -y git');
  assert.equal((await setup.install({ confirmed: true })).available, true);
  const install = calls.find(({ argv }) => argv[1] === '-n');
  assert.deepEqual(install.argv, ['sudo', '-n', 'apt-get', 'install', '-y', 'git']);
  assert.equal(install.env.DEBIAN_FRONTEND, 'noninteractive');
});

test('non-root without sudo is manual-only', async () => {
  const { setup, calls } = fixture(({ argv }) => argv[0] === 'apt-get' ? {} : missing(), { uid: 1000 });
  const status = await setup.status();
  assert.equal(status.installable, false);
  assert.equal(status.command, undefined);
  assert.ok(status.manualCommand);
  await assert.rejects(setup.install({ confirmed: true }), code('git_install_unavailable'));
  assert.ok(calls.every(({ argv }) => argv[1] === '--version'));
});

for (const failure of [
  { exitCode: 1602, stderr: 'PRIVATE_STDERR' },
  { error: new Error('PRIVATE_STDERR') },
  'throw',
]) {
  test(`installer cancellation/failure is safe and stable: ${typeof failure === 'string' ? failure : failure.exitCode ?? 'rejection'}`, async () => {
    const { setup } = fixture(({ argv }) => {
      if (argv[0] !== 'winget') return missing();
      if (argv[1] === '--version') return {};
      if (failure === 'throw') throw new Error('PRIVATE_STDERR');
      return failure;
    }, { platform: 'win32' });
    await assert.rejects(setup.install({ confirmed: true }), code('git_install_failed'));
  });
}

test('an installer exit of zero without working Git is not success', async () => {
  const { setup } = fixture(({ argv }) => argv[0] === 'winget' ? {} : missing(), { platform: 'win32' });
  await assert.rejects(setup.install({ confirmed: true }), code('git_install_failed'));
});

test('installer timeout aborts even if done never settles and allows retry', async () => {
  let retry = false;
  let installed = false;
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === 'git' && installed) return gitVersion;
    if (argv[0] !== 'winget') return missing();
    if (argv[1] === '--version') return {};
    if (retry) { installed = true; return {}; }
    return { done: new Promise(() => {}) };
  }, { platform: 'win32' });
  await assert.rejects(setup.install({ confirmed: true }), code('git_install_timeout'));
  assert.equal(calls.find(({ argv }) => argv[1] === 'install').signal.aborted, true);
  retry = true;
  assert.equal((await setup.install({ confirmed: true })).available, true);
});

test('concurrent confirmed installs are single-flight and cannot bypass confirmation', async () => {
  let finish;
  let started;
  let installed = false;
  const ready = new Promise((resolve) => { started = resolve; });
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === 'git' && installed) return gitVersion;
    if (argv[0] !== 'winget') return missing();
    if (argv[1] === '--version') return {};
    started();
    return { done: new Promise((resolve) => { finish = resolve; }) };
  }, { platform: 'win32', installTimeoutMs: 1000 });
  const first = setup.install({ confirmed: true });
  const second = setup.install({ confirmed: true });
  await ready;
  await assert.rejects(setup.install({ confirmed: false }), code('git_install_confirmation_required'));
  installed = true;
  finish({ exitCode: 0 });
  assert.deepEqual(await first, await second);
  assert.equal((await setup.install({ confirmed: true })).available, true);
  assert.equal(calls.filter(({ argv }) => argv[1] === 'install').length, 1);
});

test('malformed installation inputs also require explicit confirmation', async () => {
  const { setup, calls } = fixture();
  for (const input of [null, true, 'true', 1]) {
    await assert.rejects(setup.install(input), code('git_install_confirmation_required'));
  }
  assert.equal(calls.length, 0);
});

test('concurrent failures share one installer and one safe error', async () => {
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] !== 'winget') return missing();
    if (argv[1] === '--version') return {};
    started();
    return { done: new Promise((resolve) => { finish = resolve; }) };
  }, { platform: 'win32', installTimeoutMs: 1000 });
  const first = setup.install({ confirmed: true });
  const second = setup.install({ confirmed: true });
  await ready;
  finish({ exitCode: 1 });
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'git_install_failed'));
  assert.equal(results[0].reason, results[1].reason);
  assert.equal(calls.filter(({ argv }) => argv[1] === 'install').length, 1);
});

for (const [name, located] of [
  ['nonzero which exit', { exitCode: 1 }],
  ['empty which output', {}],
  ['which timeout', { done: new Promise(() => {}) }],
  ['missing which', missing()],
]) {
  test(`macOS never invokes an unverified PATH Git after ${name}`, async () => {
    const { setup, calls } = fixture(({ argv }) => {
      if (argv[0] === '/usr/bin/which') return located;
      return argv[0] === 'git' ? gitVersion : missing();
    }, { platform: 'darwin' });
    assert.equal((await setup.status()).available, false);
    assert.ok(calls.every(({ argv }) => argv[0] !== 'git'));
  });
}

test('macOS without developer tools does not invoke the Apple installer stub', async () => {
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === '/usr/bin/which') return { stdout: '/usr/bin/git\n' };
    if (argv[0] === '/usr/bin/xcode-select') return { exitCode: 2 };
    if (argv[0] === 'git') throw new Error('Apple installer stub must not run');
    return missing();
  }, { platform: 'darwin' });
  assert.deepEqual(await setup.status(), {
    available: false, platform: 'darwin', installable: false,
    manualCommand: 'https://git-scm.com/download/mac',
  });
  assert.ok(calls.every(({ argv }) => argv[0] !== 'git'));
});

test('macOS with configured developer tools still verifies PATH Git', async () => {
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === '/usr/bin/which') return { stdout: '/usr/bin/git\n' };
    if (argv[0] === '/usr/bin/xcode-select') return { stdout: '/Library/Developer/CommandLineTools\n' };
    return argv[0] === 'git' ? gitVersion : missing();
  }, { platform: 'darwin' });
  assert.equal(await setup.resolveGit(), 'git');
  assert.deepEqual(calls.at(-1).argv, ['git', '--version']);
});

test('macOS skips an unconfigured Apple stub and confirms Homebrew installation', async () => {
  let installed = false;
  const { setup, calls } = fixture(({ argv }) => {
    if (argv[0] === '/usr/bin/which') return { stdout: '/usr/bin/git\n' };
    if (argv[0] === '/usr/bin/xcode-select') return { exitCode: 2 };
    if (argv[0] === '/opt/homebrew/bin/git' && installed) return gitVersion;
    if (argv[0] === 'brew') {
      if (argv[1] === 'install') installed = true;
      return {};
    }
    return missing();
  }, { platform: 'darwin' });
  assert.equal((await setup.install({ confirmed: true })).executable, '/opt/homebrew/bin/git');
  assert.ok(calls.every(({ argv }) => argv[0] !== 'git'));
});
