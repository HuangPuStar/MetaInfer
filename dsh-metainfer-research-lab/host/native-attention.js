/**
 * OS-level taskbar attention for the DeepSeek Harness desktop shell.
 *
 * The plugin Host runs inside the desktop app's Node-mode process, so it can
 * ask the OS to highlight the Harness window when a node reaches a terminal
 * state while the window is unfocused. The Client still owns the user-facing
 * message (system notification) and the chime; this module only adds the
 * native "look here" signal that a web page cannot express.
 *
 * Best-effort by design:
 * - win32: user32!FlashWindowEx on the first windowed "DeepSeek*" process.
 * - linux: EWMH demands-attention via wmctrl (X11; no-op when unavailable).
 * - darwin: macOS exposes Dock bouncing only to the app itself, not to a
 *   child process, so the call reports `supported:false` and the renderer
 *   notification stays the visible signal.
 */
import { execFile } from 'node:child_process';

const ATTENTION_TIMEOUT_MS = 5000;
const SUPPORTED_KINDS = new Set(['completed', 'failed', 'cancelled']);

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Namespace DshAttention -Name Native -MemberDefinition @'",
  '[StructLayout(LayoutKind.Sequential)]',
  'public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }',
  '[DllImport("user32.dll")]',
  'public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);',
  "'@",
  "$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like 'DeepSeek*' } | Select-Object -First 1",
  'if ($null -eq $proc) { exit 2 }',
  '$info = New-Object DshAttention.Native+FLASHWINFO',
  '$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)',
  '$info.hwnd = $proc.MainWindowHandle',
  '$info.dwFlags = 3',
  '$info.uCount = 5',
  '$info.dwTimeout = 0',
  "if ([DshAttention.Native]::FlashWindowEx([ref]$info)) { Write-Output ('flashed:' + $proc.ProcessName) } else { exit 3 }",
].join('\n');

const LINUX_SCRIPT = [
  'id=$(wmctrl -lx 2>/dev/null | awk \'tolower($0) ~ /deepseek/ {print $1; exit}\')',
  'if [ -n "$id" ] && wmctrl -i -r "$id" -b add,demands_attention 2>/dev/null; then echo "flashed:$id"; fi',
  'exit 0',
].join('\n');

/**
 * The command used to raise native attention, or null when the platform has
 * no plugin-callable signal. Kept pure so the self-test can assert it without
 * spawning a process.
 * @param {string} platform `process.platform`.
 * @param {string} kind `completed` | `failed` | `cancelled`.
 * @returns {{file: string, args: string[]} | null}
 */
export function nativeAttentionPlan(platform, kind) {
  if (!SUPPORTED_KINDS.has(kind)) return null;
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
    };
  }
  if (platform === 'linux') {
    return { file: 'sh', args: ['-c', LINUX_SCRIPT] };
  }
  return null;
}

/**
 * Ask the OS to highlight the Harness window. Never throws: attention is a
 * enhancement, and a missing helper must not fail the state poll that found
 * the terminal transition.
 * @param {string} kind `completed` | `failed` | `cancelled`.
 * @param {{platform?: string, execFile?: typeof execFile}} [options]
 * @returns {Promise<{supported: boolean, platform: string, delivered: boolean, reason?: string}>}
 */
export function requestNativeAttention(kind, options = {}) {
  const platform = options.platform ?? process.platform;
  const plan = nativeAttentionPlan(platform, kind);
  if (plan === null) {
    return Promise.resolve({
      supported: false,
      platform,
      delivered: false,
      reason: platform === 'darwin' ? 'dock_bounce_unavailable' : 'unsupported_platform_or_kind',
    });
  }
  const run = options.execFile ?? execFile;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      run(plan.file, plan.args, { timeout: ATTENTION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) {
          const code = error && (error.code !== undefined && error.code !== null) ? String(error.code) : 'spawn_failed';
          finish({ supported: true, platform, delivered: false, reason: code });
          return;
        }
        const output = typeof stdout === 'string' ? stdout : '';
        finish({ supported: true, platform, delivered: output.includes('flashed:') });
      });
    } catch (error) {
      finish({ supported: true, platform, delivered: false, reason: 'spawn_failed' });
    }
  });
}
