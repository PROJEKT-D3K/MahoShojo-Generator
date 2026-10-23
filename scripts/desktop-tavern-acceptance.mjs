/** Disposable Tavern Hosted stream acceptance. No installs, real accounts or providers. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { SYNTHETIC_CARD, SCENARIOS, startTavernMock } from './desktop-tavern-acceptance-mock.mjs';
import { checkPorts, contains, rejectLinks, replaceOnce, safeLaunchEnvironment, loopbackOrigin, verifyCheckout, verifyExistingTools } from './desktop-acceptance-common.mjs';

export { assertToolVersions, checkPorts, replaceOnce, loopbackOrigin } from './desktop-acceptance-common.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const native = 'apps/desktop/src-tauri/src/';
export const PATCH_FILES = ['lib.rs', 'arena_hosted.rs', 'cloud.rs', 'secret.rs'].map(name => native + name);
const PRODUCTION_ID = 'me.colanns.mahoshojo.desktop';
const PREFIX = PRODUCTION_ID + '.tavernacceptance.h';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => readFileSync(file, 'utf8');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const fail = message => { throw new Error(message); };

export function acceptancePaths(testTree, stateRoot, identifier) {
  if (!new RegExp(`^${PREFIX.replaceAll('.', '\\.')}[a-f0-9]{32}$`).test(identifier)) fail('invalid isolated identifier');
  for (const candidate of [testTree, stateRoot]) if (!path.isAbsolute(candidate)) fail('paths must be absolute');
  testTree = path.resolve(testTree); stateRoot = path.resolve(stateRoot);
  if (contains(testTree, stateRoot) || contains(stateRoot, testTree)) fail('state root and test checkout must be separate');
  return {
    testTree, stateRoot, identifier,
    config: path.join(stateRoot, 'tauri-acceptance.json'),
    webview: path.join(stateRoot, 'webview'),
    target: path.join(stateRoot, 'cargo-target'),
  };
}

export function patchSources(original, paths, origin) {
  const endpoint = loopbackOrigin(origin);
  acceptancePaths(paths.testTree, paths.stateRoot, paths.identifier);
  const result = Object.fromEntries(Object.entries(original).map(([file, value]) => [file, value.replaceAll('\r\n', '\n')]));
  const patch = (file, before, after) => { result[native + file] = replaceOnce(result[native + file], before, after, file); };
  patch('arena_hosted.rs', '    #[cfg(test)]\n    pub(crate) fn with_story_loopback_origins(', '    // Disposable acceptance checkout only.\n    pub(crate) fn with_story_loopback_origins(');
  patch('lib.rs', 'arena_hosted::ArenaState::new(library.shared_stories())',
    `arena_hosted::ArenaState::with_story_loopback_origins(library.shared_stories(), ${JSON.stringify(endpoint.origin)}, ${JSON.stringify(endpoint.origin)})`);
  patch('secret.rs', `pub const SECRET_STORE_SERVICE: &str = "${PRODUCTION_ID}";`,
    `pub const SECRET_STORE_SERVICE: &str = "${paths.identifier}";`);
  // Pin both branches: missing env/debug flags can never fall back to production.
  patch('cloud.rs', 'const CLOUD_ORIGIN_PRODUCTION: &str = "https://mahoshojo.colanns.me";',
    `const CLOUD_ORIGIN_PRODUCTION: &str = ${JSON.stringify(endpoint.origin)};`);
  patch('cloud.rs', 'option_env!("MAHOSHOJO_CLOUD_ORIGIN")', `Some(${JSON.stringify(endpoint.origin)})`);
  const guard = `#[cfg(not(debug_assertions))]\ncompile_error!("Disposable Tavern acceptance checkout cannot build release");\n\n#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {\n    // Before Builder, WebView creation, or SecretStore access.\n    let acceptance_context = tauri::generate_context!();\n    assert_eq!(acceptance_context.config().identifier, ${JSON.stringify(paths.identifier)}, "isolated Tauri config required");\n    assert_eq!(secret::SECRET_STORE_SERVICE, ${JSON.stringify(paths.identifier)});\n    assert_eq!(std::env::var("MAHOSHOJO_TAVERN_ACCEPTANCE").ok().as_deref(), Some(${JSON.stringify(paths.identifier)}), "use the acceptance launcher");\n    let acceptance_webview = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").expect("isolated WebView folder required");\n    assert_eq!(std::fs::canonicalize(acceptance_webview).expect("WebView folder missing"), std::fs::canonicalize(${JSON.stringify(paths.webview)}).expect("expected WebView folder missing"));`;
  patch('lib.rs', '#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {', guard);
  patch('lib.rs', '.build(tauri::generate_context!())', '.build(acceptance_context)');
  patch('lib.rs', '            // 单实例先于一切本地库访问', `            assert!(data_root.ends_with(${JSON.stringify(paths.identifier)}), "unexpected app data namespace");\n\n            // 单实例先于一切本地库访问`);
  return Object.fromEntries(Object.entries(result).map(([file, value]) => [file, original[file].includes('\r\n') ? value.replaceAll('\n', '\r\n') : value]));
}

export async function preflight({ testTree, stateRoot, origin, source = sourceRoot }) {
  if (!path.isAbsolute(testTree) || !path.isAbsolute(stateRoot)) fail('paths must be absolute');
  source = realpathSync(source); testTree = path.resolve(testTree); stateRoot = path.resolve(stateRoot);
  if (contains(source, testTree) || contains(testTree, source)) fail('use a separate disposable checkout; source tree is never patched');
  if (contains(source, stateRoot) || contains(stateRoot, source)) fail('state root must be outside the source checkout');
  rejectLinks(stateRoot);
  if (existsSync(stateRoot)) fail('state root must not exist; never reuse a WebView/credential identity');
  if (!existsSync(path.dirname(stateRoot))) fail('state root parent must already exist');
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  if (git(source, 'status', '--porcelain', '--untracked-files=no')) fail('source tracked files must be clean');
  verifyCheckout(testTree, tree);
  if (git(testTree, 'status', '--porcelain', '--untracked-files=all')) fail('test checkout must be clean');
  const paths = acceptancePaths(testTree, stateRoot, PREFIX + randomUUID().replaceAll('-', ''));
  const original = Object.fromEntries(PATCH_FILES.map(file => [file, read(path.join(testTree, file))]));
  const patched = patchSources(original, paths, origin);
  await checkPorts([loopbackOrigin(origin).port, 1420, { host: '::1', port: 1420 }]);
  return { version: 1, ...paths, tree, origin, original, patched };
}

export function prepare(plan) {
  // Exclusive directory + exact source hashes before any modification. Partial failures stay blocked.
  rejectLinks(plan.stateRoot); rejectLinks(plan.testTree);
  for (const file of PATCH_FILES) {
    rejectLinks(path.join(plan.testTree, file));
    if (read(path.join(plan.testTree, file)) !== plan.original[file]) fail('test source changed after preflight');
  }
  mkdirSync(plan.stateRoot);
  mkdirSync(plan.webview);
  writeFileSync(path.join(plan.stateRoot, 'synthetic-tavern.json'), JSON.stringify(SYNTHETIC_CARD, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(plan.config, JSON.stringify({ identifier: plan.identifier }, null, 2) + '\n', { flag: 'wx' });
  const hashes = {};
  for (const file of PATCH_FILES) {
    const destination = path.join(plan.testTree, file);
    const temporary = destination + '.acceptance-' + randomUUID();
    writeFileSync(temporary, plan.patched[file], { flag: 'wx' });
    // Replace the test-tree directory entry; do not mutate a potentially shared hardlink inode.
    renameSync(temporary, destination);
    hashes[file] = hash(plan.patched[file]);
  }
  const { original, patched, ...manifest } = plan;
  writeFileSync(path.join(plan.stateRoot, 'temporary.patch'), execFileSync('git', ['-C', plan.testTree, 'diff', '--', ...PATCH_FILES]));
  writeFileSync(path.join(plan.stateRoot, 'acceptance.json'), JSON.stringify({ ...manifest, hashes }, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export function validatePrepared(stateRoot) {
  if (!path.isAbsolute(stateRoot)) fail('state root must be absolute');
  stateRoot = path.resolve(stateRoot); rejectLinks(stateRoot);
  const manifest = JSON.parse(read(path.join(stateRoot, 'acceptance.json')));
  const paths = acceptancePaths(manifest.testTree, stateRoot, manifest.identifier);
  for (const [key, value] of Object.entries(paths)) if (manifest[key] !== value) fail(`isolation manifest mismatch: ${key}`);
  if (manifest.version !== 1 || !/^[a-f0-9]{40,64}$/.test(manifest.tree)) fail('invalid acceptance manifest');
  const endpoint = loopbackOrigin(manifest.origin);
  verifyCheckout(paths.testTree, manifest.tree);
  if (git(paths.testTree, 'ls-files', '--others', '--exclude-standard')) fail('unexpected untracked test checkout files');
  const changed = git(paths.testTree, 'diff', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...PATCH_FILES].sort())) fail('unexpected test checkout edits');
  // Recompute the allowed patch from immutable HEAD, not just a mutable manifest hash.
  const originals = Object.fromEntries(PATCH_FILES.map(file => [file, execFileSync('git', ['-C', paths.testTree, 'show', `HEAD:${file}`], { encoding: 'utf8' })]));
  const patched = patchSources(originals, paths, endpoint.origin);
  for (const file of PATCH_FILES) {
    rejectLinks(path.join(paths.testTree, file));
    const actual = read(path.join(paths.testTree, file));
    if (actual.replaceAll('\r\n', '\n') !== patched[file].replaceAll('\r\n', '\n') || hash(actual) !== manifest.hashes?.[file]) fail(`prepared source changed: ${file}`);
  }
  rejectLinks(paths.config); rejectLinks(paths.webview); rejectLinks(paths.target);
  if (read(paths.config) !== JSON.stringify({ identifier: paths.identifier }, null, 2) + '\n') fail('Tauri config must only set isolated identifier');
  if (readdirSync(paths.webview).length !== 0 || existsSync(path.join(stateRoot, 'launched.json'))) fail('Tavern launcher is single-use; prepare a new isolated checkout/state root');
  return manifest;
}

/** @returns {Record<string, string | undefined>} */
export function launchEnvironment(manifest, inherited = process.env) {
  return { ...safeLaunchEnvironment(manifest, inherited), CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0', MAHOSHOJO_TAVERN_ACCEPTANCE: manifest.identifier };
}

const binaryPath = manifest => path.join(manifest.target, 'debug', 'mahoshojo-desktop.exe');
export const buildArguments = manifest => ['build', '--debug', '--no-bundle', '--config', manifest.config, '--', '--locked', '--offline'];

export async function runBuild(manifest, spawnBuild) {
  const destination = path.join(manifest.stateRoot, 'build-result.json');
  writeFileSync(destination, JSON.stringify({ started: true }) + '\n', { flag: 'wx' });
  const result = await new Promise(resolve => {
    try {
      const child = spawnBuild();
      child.once('error', () => resolve({ code: null, signal: 'spawn-error' }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    } catch { resolve({ code: null, signal: 'spawn-error' }); }
  });
  writeFileSync(destination, JSON.stringify(result) + '\n');
  if (result.code !== 0 || result.signal) fail('build failed; preserve evidence and prepare fresh copies');
  validatePrepared(manifest.stateRoot);
  writeFileSync(path.join(manifest.stateRoot, 'built.json'), JSON.stringify({ tree: manifest.tree, executable: hash(readFileSync(binaryPath(manifest))) }) + '\n', { flag: 'wx' });
}

async function build(stateRoot) {
  if (process.platform !== 'win32') fail('build is Windows-only; headless tests do not replace Tauri/Windows acceptance');
  const manifest = validatePrepared(stateRoot);
  if (existsSync(manifest.target) || existsSync(path.join(stateRoot, 'build-result.json'))) fail('build is single-use; target must be fresh');
  const app = path.join(manifest.testTree, 'apps/desktop');
  const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js');
  if (!existsSync(cli) || !existsSync(path.join(app, 'node_modules/vite'))) fail('existing test-checkout dependencies are required; this script never installs them');
  const env = launchEnvironment(manifest);
  verifyExistingTools(manifest, env);
  await runBuild(manifest, () => spawn(process.execPath, [cli, ...buildArguments(manifest)], { cwd: app, env, stdio: 'inherit', shell: false }));
}

async function launch(stateRoot) {
  if (process.platform !== 'win32') fail('launch is Windows-only; headless tests do not replace Tauri/Windows acceptance');
  const manifest = validatePrepared(stateRoot);
  const built = JSON.parse(read(path.join(stateRoot, 'built.json')));
  if (built.tree !== manifest.tree || built.executable !== hash(readFileSync(binaryPath(manifest)))) fail('matching isolated debug build required');
  if (git(sourceRoot, 'rev-parse', 'HEAD^{tree}') !== manifest.tree || git(sourceRoot, 'status', '--porcelain', '--untracked-files=no')) fail('launcher source must remain clean and match prepared tree');
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) fail('Windows app data directory is unavailable');
    if (existsSync(path.join(base, manifest.identifier))) fail('isolated application namespace already exists');
  }
  const mock = await startTavernMock({ port: loopbackOrigin(manifest.origin).port });
  await runAcceptance(manifest, mock, () => spawn(binaryPath(manifest), [],
    { cwd: path.join(manifest.testTree, 'apps/desktop'), env: launchEnvironment(manifest), stdio: 'ignore', shell: false }));
}

/** Console controls are local closed enums; observations do not certify UI/IPC acceptance. */
export async function runAcceptance(manifest, mock, spawnApp, {
  inputStream = process.stdin, signals = process, report = value => console.log(value),
} = {}) {
  const input = readline.createInterface({ input: inputStream });
  let child, ended, requestedStop = false;
  const stop = () => { requestedStop = true; if (child && child.exitCode === null) child.kill(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  try {
    writeFileSync(path.join(manifest.stateRoot, 'launched.json'), JSON.stringify({ origin: manifest.origin }) + '\n', { flag: 'wx' });
    child = spawnApp();
    ended = new Promise(resolve => {
      child.once('error', () => resolve({ code: null, signal: 'spawn-error' }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    report(`Synthetic Tavern ready. Commands: scenario ${SCENARIOS.join('|')}, observe, stop. Use synthetic-tavern.json only.`);
    input.on('line', line => {
      if (line === 'stop') { stop(); return; }
      if (line === 'observe') { report(JSON.stringify(mock.trace())); return; }
      const match = /^scenario ([a-z-]+)$/.exec(line);
      if (!match) { report('Unknown command'); return; }
      try { mock.setScenario(match[1]); report(`Scenario: ${match[1]}`); }
      catch { report('Scenario refused: use a known scenario after the active stream has closed'); }
    });
    const result = await ended;
    writeFileSync(path.join(manifest.stateRoot, 'application-exit.json'), JSON.stringify({ ...result, requestedStop }) + '\n', { flag: 'wx' });
    if (result.code !== 0 && !requestedStop) fail('application did not exit successfully');
  } finally {
    input.close(); signals.off('SIGINT', stop); signals.off('SIGTERM', stop);
    if (child && child.exitCode === null) child.kill();
    if (ended) await ended;
    await mock.close();
    writeFileSync(path.join(manifest.stateRoot, 'mock-trace.json'), JSON.stringify(mock.trace(), null, 2) + '\n', { flag: 'wx' });
  }
}

export async function main(args) {
  const mode = args.shift();
  if (!['preflight', 'prepare', 'build', 'launch'].includes(mode)) fail('expected preflight, prepare, build or launch');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--test-tree', '--state-root', '--origin'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  if (!options['--state-root']) fail('required: --state-root <absolute new directory>');
  if (['build', 'launch'].includes(mode)) {
    if (Object.keys(options).length !== 1) fail('build/launch accepts only --state-root');
    if (mode === 'build') return build(options['--state-root']);
    return launch(options['--state-root']);
  }
  if (!options['--test-tree'] || !options['--origin']) fail('required: --test-tree, --state-root and --origin');
  const plan = await preflight({ testTree: options['--test-tree'], stateRoot: options['--state-root'], origin: options['--origin'] });
  if (mode === 'prepare') prepare(plan);
  console.log(JSON.stringify({ mode, testTree: plan.testTree, stateRoot: plan.stateRoot, identifier: plan.identifier, origin: plan.origin, prepared: mode === 'prepare', applicationStarted: false }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
