/** Shared isolation checks for disposable Desktop acceptance launchers. */
import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const read = file => readFileSync(file, 'utf8');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

const fail = message => { throw new Error(message); };

export function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) fail(`patch anchor changed or duplicated: ${label}`);
  return source.replace(before, after);
}

export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function rejectLinks(candidate) {
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)) fail('isolated path must not contain symlinks/junctions');
    if (path.dirname(current) === current) break;
  }
}

export async function checkPorts(ports) {
  const reservations = [];
  try {
    for (const binding of ports) {
      const { port, host } = typeof binding === 'number' ? { port: binding, host: '127.0.0.1' } : binding;
      if (!['127.0.0.1', '::1'].includes(host)) fail('only loopback port probes are permitted');
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port, exclusive: true }, resolve); });
      reservations.push(server);
    }
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

/** @returns {Record<string, string | undefined>} */
export function safeLaunchEnvironment(manifest, inherited = process.env) {
  const env = {};
  // Do not inherit app tokens, proxy, TAURI_CONFIG, WebView browser args, RUSTFLAGS or Cargo overrides.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|CARGO_HOME|RUSTUP_HOME)$/i;
  for (const [key, value] of Object.entries(inherited)) if (allowed.test(key)) env[key] = value;
  return { ...env, WEBVIEW2_USER_DATA_FOLDER: manifest.webview, CARGO_TARGET_DIR: manifest.target, CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: '0', CI: 'true',
    pnpm_config_pm_on_fail: 'error', pnpm_config_runtime_on_fail: 'error',
    pnpm_config_verify_deps_before_run: 'error', pnpm_config_offline: 'true',
    npm_config_manage_package_manager_versions: 'false', npm_config_package_manager_strict_version: 'true' };
}

export function assertToolVersions({ pnpm, cargo, rustc, expectedPnpm, minimumRust }) {
  if (pnpm.trim() !== expectedPnpm) fail(`existing pnpm ${expectedPnpm} is required; automatic installation is disabled`);
  const minimum = minimumRust.split('.').map(Number);
  for (const [name, output] of Object.entries({ cargo, rustc })) {
    const match = new RegExp(`^${name} (\\d+)\\.(\\d+)\\.(\\d+)(?: |$)`).exec(output.trim());
    if (!match || Number(match[1]) !== minimum[0] || Number(match[2]) < minimum[1]) fail(`existing ${name} >= ${minimumRust} stable is required; automatic installation is disabled`);
  }
}

export function loopbackOrigin(input) {
  // Reject URL canonicalization tricks, implicit ports, credentials and non-origin paths.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(input ?? '');
  if (!match || Number(match[1]) > 65535 || Number(match[1]) === 1420) fail('origin must be explicit http://127.0.0.1:<1..65535>, excluding Vite 1420');
  return { origin: input, port: Number(match[1]) };
}

export function verifyCheckout(root, expectedTree) {
  rejectLinks(root);
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== realpathSync(root)) fail('test-tree must be the checkout root');
  if (expectedTree && git(root, 'rev-parse', 'HEAD^{tree}') !== expectedTree) fail('test checkout differs from source tree');
  // Refuse ignored environment/config overrides too, without reading their values.
  for (const directory of [root, path.join(root, 'apps/desktop'), path.join(root, 'apps/desktop/src-tauri')]) {
    for (const entry of readdirSync(directory)) {
      if ((/^\.env(?:\.|$)/i.test(entry) && !/\.(example|sample)$/i.test(entry)) || /^tauri\.(windows|linux|macos)(?:\.conf\.|\.toml$)/i.test(entry) || /^(?:tauri\.conf\.json5|tauri\.toml)$/i.test(entry)) fail('test checkout contains an environment/platform override');
    }
  }
}

export function verifyExistingTools(manifest, env) {
  const expectedPnpm = JSON.parse(read(path.join(manifest.testTree, 'package.json'))).packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  const minimumRust = read(path.join(manifest.testTree, 'apps/desktop/src-tauri/Cargo.toml')).match(/^rust-version = "(\d+\.\d+)"$/m)?.[1];
  if (!expectedPnpm || !minimumRust) fail('toolchain declarations changed; review the harness before launching');
  const options = { cwd: manifest.testTree, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] };
  let pnpm, cargo, rustc;
  try {
    // Static command only. Corepack/pnpm/rustup have no-install guards before even these probes.
    pnpm = execFileSync(path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32/cmd.exe'), ['/d', '/s', '/c', 'pnpm --version'], options);
    cargo = execFileSync('cargo', ['--version'], options);
    rustc = execFileSync('rustc', ['--version'], options);
  } catch { fail('existing pnpm/Cargo/Rust tools are missing or unavailable; no tools were requested for installation'); }
  assertToolVersions({ pnpm, cargo, rustc, expectedPnpm, minimumRust });
}
