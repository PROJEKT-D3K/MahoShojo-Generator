import { readFile, writeFile } from 'node:fs/promises';

// Desktop 版本号只有一个权威来源：apps/desktop/package.json 的 version。
// 本脚本把它同步到三个派生位置：
//   - tauri.conf.json：安装包/bundle 与 Tauri 配置声明的版本
//   - Cargo.toml：crate 版本，也是运行时 appVersion（package_info().version）的来源
//   - Cargo.lock：锁文件中 mahoshojo-desktop 自身包记录
// `--check` 只校验不改写，供 CI 与 workspace:checks 使用；不带参数时实际同步。
// 发布新版本时先改 apps/desktop/package.json，再运行 `pnpm run sync:desktop-version`。

const desktopPackageJson = new URL('../apps/desktop/package.json', import.meta.url);
const tauriConfJson = new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url);
const cargoToml = new URL('../apps/desktop/src-tauri/Cargo.toml', import.meta.url);
const cargoLock = new URL('../apps/desktop/src-tauri/Cargo.lock', import.meta.url);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const version = JSON.parse(await readFile(desktopPackageJson, 'utf8')).version;
if (typeof version !== 'string' || !SEMVER.test(version)) {
  throw new Error(`apps/desktop/package.json 的 version 非法：${JSON.stringify(version)}`);
}

// 在某个 TOML 文本块中替换 `version = "..."` 行。
// blockRe 必须匹配一个不跨越下一个 `[`（即下一个 TOML 段头）的文本块，
// 且块内第一个以 version 开头的行就是要同步的字段。
// 行首锚定确保不会命中 rust-version、dependencies 里的 `{ version = "x" }` 等写法。
const VERSION_LINE = /^version\s*=\s*"[^"]*"/mu;
function syncTomlBlock(text, blockRe, label) {
  const match = text.match(blockRe);
  if (!match) throw new Error(`${label} 中未找到目标包记录`);
  const block = match[0];
  const line = block.match(VERSION_LINE);
  if (!line) throw new Error(`${label} 缺少 version 字段`);
  const current = line[0].match(/"([^"]*)"/u)[1];
  const next = block.replace(VERSION_LINE, `version = "${version}"`);
  return {
    current,
    text: `${text.slice(0, match.index)}${next}${text.slice(match.index + block.length)}`,
  };
}

const targets = [
  {
    label: 'apps/desktop/src-tauri/tauri.conf.json',
    url: tauriConfJson,
    read(text) {
      const current = JSON.parse(text).version;
      if (typeof current !== 'string') throw new Error('tauri.conf.json 缺少 version 字段');
      return { current, text };
    },
    render(text) {
      const conf = JSON.parse(text);
      conf.version = version;
      return `${JSON.stringify(conf, null, 2)}\n`;
    },
  },
  {
    label: 'apps/desktop/src-tauri/Cargo.toml',
    url: cargoToml,
    read: (text) => syncTomlBlock(text, /\[package\][^[]*/u, 'Cargo.toml [package]'),
    render: (text) => syncTomlBlock(text, /\[package\][^[]*/u, 'Cargo.toml [package]').text,
  },
  {
    label: 'apps/desktop/src-tauri/Cargo.lock',
    url: cargoLock,
    read: (text) =>
      syncTomlBlock(
        text,
        /\[\[package\]\][^[]*name = "mahoshojo-desktop"[^[]*/u,
        'Cargo.lock mahoshojo-desktop',
      ),
    render: (text) =>
      syncTomlBlock(
        text,
        /\[\[package\]\][^[]*name = "mahoshojo-desktop"[^[]*/u,
        'Cargo.lock mahoshojo-desktop',
      ).text,
  },
];

const checkOnly = process.argv.includes('--check');
const drift = [];
for (const target of targets) {
  const original = await readFile(target.url, 'utf8');
  const { current } = target.read(original);
  if (checkOnly) {
    if (current !== version) drift.push(`${target.label}: ${current} != ${version}`);
    continue;
  }
  const next = target.render(original);
  if (next !== original) await writeFile(target.url, next);
  console.log(`${target.label}: ${current} -> ${version}`);
}
if (drift.length > 0) {
  throw new Error(
    `Desktop 版本不同步，请先修改 apps/desktop/package.json 后运行 pnpm run sync:desktop-version\n${drift.join('\n')}`,
  );
}
