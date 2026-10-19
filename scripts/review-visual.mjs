#!/usr/bin/env node
/**
 * VIS-REVIEW-001 本地视觉巡检（显式命令，不进 workspace:checks / CI / 提交门禁）。
 *
 * 做什么：对开发服务器上的样板间与代表页面跑条件矩阵
 * （亮/暗 × 代表视口 × forced-colors × 200% 根字号），
 * 做 getComputedStyle 对比度抽查与几何断言（横向溢出、焦点可见性），
 * 恒写 report.json；--screenshots 时把各条件截图落到 .tmp/visual-review/。
 *
 * 不做什么：不设像素阈值、不维护黄金图、不做 CI 截图门禁。
 * 浏览器模拟的 forced-colors/viewport 只是工程近似，不构成原生高对比主题
 * 或 WebView2 验收——那些仍按 runbook 人工走。
 *
 * 用法：
 *   node scripts/review-visual.mjs [--screenshots] [--url http://127.0.0.1:3110]
 *                                  [--no-server] [--routes /dev/showroom,/]
 *
 * --no-server 复用已在 --url 运行中的开发服务器；否则脚本自己拉起
 * `next dev`（独立端口，结束时负责回收）。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, '.tmp', 'visual-review');
const requireFromWeb = createRequire(path.join(REPO_ROOT, 'apps', 'web', 'package.json'));

// ---------- 参数 ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE_URL = opt('url', 'http://localhost:3110');
const TAKE_SCREENSHOTS = flag('screenshots');
const MANAGE_SERVER = !flag('no-server');
const ROUTES = opt('routes', '/dev/showroom,/').split(',').map((r) => r.trim()).filter(Boolean);

// ---------- 条件矩阵 ----------

/**
 * 每一档是一次独立 context：colorScheme/viewport 是 context 属性，
 * forcedColors 与根字号放大进 page 后设置。
 */
const CONDITIONS = [
  { name: 'light-1280', colorScheme: 'light', viewport: { width: 1280, height: 800 } },
  { name: 'dark-1280', colorScheme: 'dark', viewport: { width: 1280, height: 800 } },
  { name: 'light-375', colorScheme: 'light', viewport: { width: 375, height: 812 } },
  { name: 'dark-375', colorScheme: 'dark', viewport: { width: 375, height: 812 } },
  { name: 'dark-1280-forced-colors', colorScheme: 'dark', viewport: { width: 1280, height: 800 }, forcedColors: 'active' },
  { name: 'light-1280-zoom200', colorScheme: 'light', viewport: { width: 1280, height: 800 }, rootFontScale: 2 },
];

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gitSha = () => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const waitForServer = async (url, timeoutMs, checkStartup = () => {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    checkStartup();
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))),
      });
      if (response.status < 500) {
        checkStartup();
        return true;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.cause?.code ?? error?.message ?? error);
    }
    await sleep(1000);
  }
  checkStartup();
  throw new Error(`等待 ${url} 就绪超时（${timeoutMs / 1000}s）：${lastError}`);
};

const startDevServer = () => {
  const url = new URL(BASE_URL);
  const port = url.port || '80';
  console.log(`[review:visual] 拉起 next dev（端口 ${port}）…`);
  const nextArgs = ['--filter', 'web', 'exec', 'next', 'dev', '--turbopack', '--port', port];
  const [command, spawnArgs] = process.platform === 'win32'
    ? ['cmd', ['/c', 'pnpm', ...nextArgs]]
    : ['pnpm', nextArgs];
  const child = spawn(command, spawnArgs, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    // 只给本脚本自启的 pnpm/next 建独立进程组，回收时不触碰外部服务。
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`  [next] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`  [next] ${chunk}`));
  return child;
};

const stopDevServer = async (server) => {
  if (!server.pid) return; // spawn 失败，没有可回收进程。
  if (process.platform === 'win32') {
    // pnpm.cmd 的包装进程不足以代表 next dev；按自启 PID 回收整棵树。
    await new Promise((resolve, reject) => {
      const cleanup = spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
      cleanup.once('error', reject);
      cleanup.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`taskkill 退出码 ${code}`)));
    });
  } else {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
};

// ---------- 页面内断言（浏览器侧执行） ----------

const PAGE_AUDIT = () => {
  const findings = [];

  // 1. 横向溢出：内容不应超出视口宽（留 1px 抖动余量）。
  const doc = document.documentElement;
  const overflowX = doc.scrollWidth - doc.clientWidth;
  if (overflowX > 1) {
    findings.push({
      severity: 'fail',
      kind: 'horizontal-overflow',
      detail: `scrollWidth ${doc.scrollWidth} 超出 clientWidth ${doc.clientWidth}（+${overflowX}px）`,
    });
  }

  // 2. 对比度抽查：对页面可见文本节点，取元素前景色与最近非透明祖先背景
  //    合成后按 WCAG 相对亮度计算。样本上限 40 个元素。
  const srgbChannel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
  const parseColor = (raw) => {
    const match = /rgba?\(([^)]+)\)/.exec(raw ?? '');
    if (!match) return null;
    const parts = match[1].split(',').map((part) => Number.parseFloat(part));
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, bg) => [
    fg.rgb[0] * fg.alpha + bg.rgb[0] * (1 - fg.alpha),
    fg.rgb[1] * fg.alpha + bg.rgb[1] * (1 - fg.alpha),
    fg.rgb[2] * fg.alpha + bg.rgb[2] * (1 - fg.alpha),
  ];
  const effectiveBackground = (element) => {
    let node = element;
    while (node && node !== document.documentElement) {
      const parsed = parseColor(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.alpha > 0) {
        // 非完全不透明时与页面底色（body/html 背景或白）继续合成——近似取白，
        // 因为主题页底本身是渐变，无单一背景色可比。
        if (parsed.alpha >= 1) return parsed;
        return { rgb: blend(parsed, { rgb: [255, 255, 255], alpha: 1 }), alpha: 1 };
      }
      node = node.parentElement;
    }
    return null;
  };
  const contrastRatio = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const textCandidates = [...document.querySelectorAll('h1, h2, h3, p, a, button, label, code, span')]
    .filter((el) => {
      const text = (el.textContent ?? '').trim();
      if (!text || text.length > 200) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .slice(0, 40);

  const lowContrast = [];
  for (const el of textCandidates) {
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    const bg = effectiveBackground(el);
    if (!fg || !bg || fg.alpha === 0) continue;
    const ratio = contrastRatio(blend(fg, bg), bg.rgb);
    const fontSize = Number.parseFloat(style.fontSize);
    const largeText = fontSize >= 24 || (fontSize >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700);
    const threshold = largeText ? 3 : 4.5;
    if (ratio < threshold) {
      lowContrast.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 40), ratio: Number(ratio.toFixed(2)), threshold });
    }
  }
  if (lowContrast.length > 0) {
    findings.push({
      severity: 'warn',
      kind: 'low-contrast-samples',
      detail: `${lowContrast.length} 个抽样元素低于阈值（对照 design-contrast 已知缺口表核实后处理）`,
      samples: lowContrast.slice(0, 8),
    });
  }

  // 3. 焦点可见性：首个可聚焦元素获得可见轮廓（outline 或 box-shadow 环）。
  const focusable = document.querySelector('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (focusable) {
    focusable.focus();
    const focused = document.activeElement;
    const style = focused ? getComputedStyle(focused) : null;
    const visible = style && (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
      (style.boxShadow !== 'none' && style.boxShadow !== '') ||
      style.outlineColor !== 'rgba(0, 0, 0, 0)'
    );
    findings.push({
      severity: focused === focusable && visible ? 'info' : 'warn',
      kind: 'focus-visibility',
      detail: focused === focusable && visible
        ? `首个可聚焦元素（${focusable.tagName.toLowerCase()}）焦点可见`
        : `首个可聚焦元素焦点不可见或未命中（active=${focused?.tagName?.toLowerCase() ?? 'none'}）`,
    });
  }

  return findings;
};

// ---------- 主流程 ----------

export const main = async () => {
  let server = null;
  let serverOwned = false;
  let browser = null;
  let failure = null;
  let phase = 'output-directory';

  const report = {
    tool: 'review-visual',
    generatedAt: new Date().toISOString(),
    sha: gitSha(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    baseUrl: BASE_URL,
    server: serverOwned ? 'spawned-next-dev' : 'external',
    screenshots: TAKE_SCREENSHOTS,
    matrix: [],
    errors: [],
    unverified: [
      'Desktop WebView2 未巡检——Tauri 真机验收按 runbook 人工走',
      '像素级外观比对不在本工具范围（无黄金图、无阈值）',
      'forced-colors 为浏览器模拟，不构成原生高对比主题验收',
    ],
    totals: { conditions: 0, findings: { fail: 0, warn: 0, info: 0 } },
  };

  const recordFailure = (stage, error) => {
    failure ??= error;
    report.errors.push({ stage, detail: String(error?.stack ?? error) });
    report.totals.findings.fail += 1;
  };

  try {
    mkdirSync(OUT_DIR, { recursive: true });
    phase = 'server-readiness';
    if (MANAGE_SERVER) {
      try {
        await waitForServer(BASE_URL, 2000);
        console.log(`[review:visual] 复用已在 ${BASE_URL} 运行的服务器`);
      } catch {
        server = startDevServer();
        serverOwned = true;
        let startupError = null;
        server.on('error', (error) => { startupError = error; });
        server.once('exit', (code, signal) => {
          startupError ??= new Error(`next dev 提前退出（code=${code}, signal=${signal}）`);
        });
        await waitForServer(BASE_URL, 90_000, () => { if (startupError) throw startupError; });
        console.log(`[review:visual] 开发服务器就绪`);
      }
    } else {
      await waitForServer(BASE_URL, 10_000);
      console.log(`[review:visual] 使用外部服务器 ${BASE_URL}`);
    }

    report.server = serverOwned ? 'spawned-next-dev' : 'external';
    phase = 'browser-launch';
    const { chromium } = requireFromWeb('playwright');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    phase = 'page-audit';
    for (const route of ROUTES) {
      for (const condition of CONDITIONS) {
        const context = await browser.newContext({
          colorScheme: condition.colorScheme,
          viewport: condition.viewport,
          forcedColors: condition.forcedColors ?? 'none',
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        const entry = {
          route,
          condition: condition.name,
          viewport: `${condition.viewport.width}x${condition.viewport.height}`,
          colorScheme: condition.colorScheme,
          forcedColors: condition.forcedColors ?? 'none',
          deviceScaleFactor: 1,
          rootFontScale: condition.rootFontScale ?? 1,
          findings: [],
          screenshot: null,
        };

        try {
          const url = `${BASE_URL}${route}`;
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          if (!response || !response.ok()) {
            entry.findings.push({ severity: 'fail', kind: 'navigation', detail: `${url} 返回 ${response?.status() ?? 'no-response'}` });
          } else {
            // colorScheme 模拟只管 prefers-color-scheme；产品还有显式 data-color-mode
            // 偏好（localStorage）——显式写入以让两种机制一致指向目标主题。
            await page.evaluate((scheme) => {
              try {
                window.localStorage.setItem('color-mode', scheme);
              } catch { /* 受限环境忽略 */ }
            }, condition.colorScheme);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

            if (condition.rootFontScale) {
              await page.evaluate((scale) => {
                document.documentElement.style.fontSize = `${scale * 100}%`;
              }, condition.rootFontScale);
              await page.waitForTimeout(200);
            }

            entry.findings = await page.evaluate(PAGE_AUDIT);
          }
        } catch (error) {
          entry.findings.push({ severity: 'fail', kind: 'exception', detail: String(error?.message ?? error) });
        }

        if (TAKE_SCREENSHOTS) {
          const safeRoute = route.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'index';
          const file = `${safeRoute}--${condition.name}.png`;
          const target = path.join(OUT_DIR, file);
          try {
            await page.screenshot({ path: target, fullPage: true });
            entry.screenshot = path.relative(REPO_ROOT, target).replaceAll('\\', '/');
          } catch (error) {
            entry.findings.push({ severity: 'warn', kind: 'screenshot', detail: `截图失败：${error?.message ?? error}` });
          }
        }

        for (const finding of entry.findings) {
          report.totals.findings[finding.severity] = (report.totals.findings[finding.severity] ?? 0) + 1;
        }
        report.totals.conditions += 1;
        report.matrix.push(entry);
        await context.close();

        const status = entry.findings.some((f) => f.severity === 'fail') ? 'FAIL'
          : entry.findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok';
        console.log(`[review:visual] ${status.padEnd(4)} ${route} @ ${condition.name}`);
      }
    }
  } catch (error) {
    recordFailure(phase, error);
  } finally {
    // 各项清理和写报告互不阻断，首个失败始终保留为最终错误。
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        recordFailure('browser-cleanup', error);
      }
    }
    if (serverOwned && server) {
      report.server = 'spawned-next-dev';
      try {
        await stopDevServer(server);
        console.log('[review:visual] 已请求回收开发服务器');
      } catch (error) {
        recordFailure('server-cleanup', error);
      }
    }

    const persistReport = (name) => {
      const reportPath = path.join(OUT_DIR, name);
      try {
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`[review:visual] 报告：${path.relative(REPO_ROOT, reportPath)}`);
        return true;
      } catch (error) {
        recordFailure('report-write', error);
        console.error(`[review:visual] 无法写入 ${name}：${error?.message ?? error}`);
        return false;
      }
    };
    const latestWritten = persistReport('report.json');
    const archiveWritten = persistReport(`report-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
    // 归档失败不能让已写出的 canonical report 仍声称零失败。
    if (!archiveWritten && latestWritten) persistReport('report.json');
  }

  console.log(`[review:visual] fail=${report.totals.findings.fail ?? 0} warn=${report.totals.findings.warn ?? 0} info=${report.totals.findings.info ?? 0}（${report.totals.conditions} 个条件）`);
  process.exitCode = (report.totals.findings.fail ?? 0) > 0 ? 1 : 0;
  if (failure) throw failure;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[review:visual] 失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
