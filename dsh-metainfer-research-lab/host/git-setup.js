/**
 * Host-only Git discovery and explicitly confirmed installation. No shell,
 * downloaded scripts, persistent state or password prompts. Errors omit logs.
 */
import path from 'node:path';

const MANUAL = {
  win32: 'https://git-scm.com/download/win',
  darwin: 'https://git-scm.com/download/mac',
  linux: 'https://git-scm.com/download/linux',
};
const LINUX_INSTALLERS = [
  ['apt-get', ['install', '-y', 'git']],
  ['dnf', ['install', '-y', 'git']],
  ['yum', ['install', '-y', 'git']],
  ['pacman', ['-S', '--noconfirm', '--needed', 'git']],
  ['zypper', ['--non-interactive', 'install', '--no-recommends', 'git']],
];
const WINGET_ARGS = ['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

function failure(code, message, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

function absent(error) {
  return ['ENOENT', 'ENOTDIR'].includes(error?.code) || ['ENOENT', 'ENOTDIR'].includes(error?.cause?.code);
}

function commandText(argv) {
  return argv.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
}

/**
 * options platform/env/uid and bounded probeTimeoutMs/installTimeoutMs are test
 * seams, never request parameters. Installation is single-flight per instance.
 * status/installation results: {available, version?, executable?, platform,
 * installable, manager?, command?, manualCommand}. Available Git needs no install.
 * The caller must disclose winget's package/source agreements and possible OS
 * permission dialog in its confirmation UI. No confirmation is persisted here.
 */
export function createGitSetup(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = { ...(options.env ?? process.env) };
  const uid = options.uid ?? process.getuid?.();
  const probeTimeoutMs = Math.min(10_000, Math.max(1, Number(options.probeTimeoutMs) || 5000));
  const installTimeoutMs = Math.min(300_000, Math.max(1, Number(options.installTimeoutMs) || 300_000));
  const manualCommand = MANUAL[platform] ?? 'https://git-scm.com/downloads';
  let verified;
  let installing;

  const envValue = (name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const localAppData = envValue('LOCALAPPDATA') || (envValue('USERPROFILE') && path.win32.join(envValue('USERPROFILE'), 'AppData', 'Local'));
  const windowsRoots = [envValue('ProgramFiles'), envValue('ProgramW6432'), envValue('ProgramFiles(x86)'), 'C:\\Program Files', 'C:\\Program Files (x86)'];
  const candidates = platform === 'win32'
    ? ['git', ...windowsRoots.filter(Boolean).flatMap((root) => ['cmd', 'bin'].map((dir) => path.win32.join(root, 'Git', dir, 'git.exe'))),
      ...(localAppData ? ['cmd', 'bin'].map((dir) => path.win32.join(localAppData, 'Programs', 'Git', dir, 'git.exe')) : [])]
    : platform === 'darwin'
      ? ['git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
      : ['git', '/usr/bin/git', '/usr/local/bin/git', '/bin/git'];

  async function run(argv, timeoutMs = probeTimeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
      // Race as well as abort: a broken provider must not keep the API pending.
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ timedOut: true }); }, timeoutMs);
      });
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: process.cwd(),
        env: { ...env, GIT_TERMINAL_PROMPT: '0', NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', DEBIAN_FRONTEND: 'noninteractive' },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
        graceMs: 1000,
        signal: controller.signal,
      });
      const outcome = await Promise.race([handle.done, deadline]);
      if (controller.signal.aborted) return { timedOut: true };
      return { exitCode: outcome.exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '' };
    } catch (error) {
      return { error, timedOut: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  async function detectGit() {
    let executionError;
    for (const executable of new Set([verified?.executable, ...candidates].filter(Boolean))) {
      if (platform === 'darwin' && executable === 'git') {
        // Apple's stub can launch an installer merely on --version. Never do so.
        const located = await run(['/usr/bin/which', 'git']);
        if (located.exitCode !== 0 || !located.stdout.trim()) continue;
        if (located.stdout.trim() === '/usr/bin/git') {
          const tools = await run(['/usr/bin/xcode-select', '-p']);
          if (tools.exitCode !== 0) {
            if (tools.error || tools.timedOut) executionError ??= failure('git_failed', 'Git developer tools check failed.', tools.timedOut ? 504 : 422);
            continue;
          }
        }
      }
      const result = await run([executable, '--version']);
      const version = result.stdout?.trim().match(/^git version (\d[^\r\n]*)$/)?.[1];
      if (result.exitCode === 0 && version) {
        verified = { executable, version };
        return verified;
      }
      if (!absent(result.error)) {
        executionError ??= failure('git_failed', result.timedOut ? 'Git version check timed out.' : 'Git version check failed.', result.timedOut ? 504 : 422);
      }
    }
    verified = undefined;
    throw executionError ?? failure('git_missing', 'Git is not installed or could not be found.');
  }

  async function resolveGit() {
    return (await detectGit()).executable;
  }

  async function findCommand(executables) {
    for (const executable of new Set(executables)) {
      const result = await run([executable, '--version']);
      if (result.exitCode === 0) return executable;
    }
    return undefined;
  }

  async function installPlan() {
    if (platform === 'win32') {
      const executable = await findCommand(['winget', ...(localAppData ? [path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')] : [])]);
      if (executable) return { manager: 'winget', argv: [executable, ...WINGET_ARGS] };
    } else if (platform === 'darwin') {
      const executable = await findCommand(['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
      if (executable) return { manager: 'brew', argv: [executable, 'install', 'git'] };
    } else if (platform === 'linux') {
      for (const [manager, args] of LINUX_INSTALLERS) {
        const executable = await findCommand([manager]);
        if (!executable) continue;
        if (uid === 0) return { manager, argv: [executable, ...args] };
        const sudo = await findCommand(['sudo']);
        if (sudo) return { manager, argv: [sudo, '-n', executable, ...args] };
        return undefined;
      }
    }
    return undefined;
  }

  function availableStatus(git) {
    return { available: true, version: git.version, executable: git.executable, platform, installable: false, manualCommand };
  }

  async function status() {
    try {
      return availableStatus(await detectGit());
    } catch (error) {
      if (error.code !== 'git_missing') throw error;
    }
    const plan = await installPlan();
    return {
      available: false, platform, installable: Boolean(plan),
      ...(plan ? { manager: plan.manager, command: commandText(plan.argv) } : {}),
      manualCommand,
    };
  }

  async function performInstall() {
    try {
      return availableStatus(await detectGit());
    } catch (error) {
      if (error.code !== 'git_missing') {
        throw failure(error.status === 504 ? 'git_install_timeout' : 'git_install_failed', 'Git could not be verified before installation.', error.status);
      }
    }
    const plan = await installPlan();
    if (!plan) throw failure('git_install_unavailable', 'No supported noninteractive Git installer is available.');
    const result = await run(plan.argv, installTimeoutMs);
    if (result.timedOut) throw failure('git_install_timeout', 'Git installation timed out.', 504);
    if (result.error || result.exitCode !== 0) throw failure('git_install_failed', 'Git installation failed or was cancelled.');
    verified = undefined;
    try {
      return availableStatus(await detectGit());
    } catch (error) {
      throw failure(error.status === 504 ? 'git_install_timeout' : 'git_install_failed', 'Git installation finished but Git could not be verified.', error.status);
    }
  }

  async function install(input = {}) {
    if (input?.confirmed !== true) throw failure('git_install_confirmation_required', 'Explicit confirmation is required to install Git.', 400);
    installing ??= performInstall().finally(() => { installing = undefined; });
    return installing;
  }

  return { resolveGit, status, install };
}
