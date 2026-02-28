#!/usr/bin/env node
'use strict';

/**
 * web-claude UI 自动化测试
 * 检查 chat.html 中的已知问题和功能完整性
 */

const fs   = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, 'public/chat.html');

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`✓  ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (e) {
    console.log(`✗  ${name}\n   → ${e.message}`);
    failed++;
    results.push({ name, ok: false, err: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function extractCssBlock(html, selector) {
  // 从 HTML 中提取某个 CSS 选择器的规则块
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*\\{([^}]+)\\}', 's');
  const m = html.match(re);
  return m ? m[1] : '';
}

if (!fs.existsSync(HTML_FILE)) {
  console.error('找不到文件: ' + HTML_FILE);
  process.exit(1);
}

const html = fs.readFileSync(HTML_FILE, 'utf8');

console.log('── web-claude UI 测试 ──────────────────────────────────\n');

// ─── 1. 字体可见性 ────────────────────────────────────────────────────────────

test('Claude 输出框有明确的 color 属性', () => {
  const block = extractCssBlock(html, '.msg-claude .output');
  assert(block.includes('color:') || block.includes('color :'),
    '.msg-claude .output 缺少 color 属性（依赖继承可能在部分情况下失效）');
});

test('Claude 标签 (.tag) font-size >= 0.85rem', () => {
  const block = extractCssBlock(html, '.msg-claude .tag');
  const m = block.match(/font-size:\s*([\d.]+)rem/);
  assert(m, '.msg-claude .tag 缺少 font-size');
  const size = parseFloat(m[1]);
  assert(size >= 0.85, `当前 .tag font-size=${m[1]}rem，太小（需要 >= 0.85rem）`);
});

test('Claude 输出框 (.output) font-size >= 0.9rem', () => {
  const block = extractCssBlock(html, '.msg-claude .output');
  const m = block.match(/font-size:\s*([\d.]+)rem/);
  assert(m, '.msg-claude .output 缺少 font-size');
  const size = parseFloat(m[1]);
  assert(size >= 0.9, `当前 .output font-size=${m[1]}rem，偏小（需要 >= 0.9rem）`);
});

// ─── 2. ANSI 颜色对比度 ───────────────────────────────────────────────────────

test('ANSI 颜色 30 不是 #44475a（在深色背景下不可见）', () => {
  assert(!html.includes("30:'#44475a'"),
    "ANSI_FG[30] = '#44475a' 在 #1e2030 背景上对比度仅约 1.8:1，字体几乎不可见");
});

test('256色 color[0] 不是 #21222c（与背景 #1e2030 近乎相同）', () => {
  // color256(0) 用作前景色时，#21222c 与背景 #1e2030 对比度约 1:1，完全不可见
  assert(!html.includes("'#21222c'"),
    "color256(0) = '#21222c' 与背景 #1e2030 几乎无对比度，使用 256色前景色 0 的文字不可见");
});

test('\\r 处理使用 replace 而非贪婪剥离', () => {
  // Claude Code TUI 用光标定位（而非 \\n）分行，贪婪 [^\\n]*\\r 剥离会
  // 把响应文字当成 spinner 前缀一起清除，导致 .output 内容为空
  assert(!html.includes("[^\\\\n]*\\\\r(?!\\\\n)/g, ''"),
    "贪婪 \\r 剥离会将 TUI 中的响应内容错误清除，应改用 replace(/\\r/g, '\\n')");
});

test('ANSI dim 效果 opacity >= 0.65', () => {
  // 检查 opacity:0.55 这个问题值
  const m = html.match(/c === 2[^)]*\)\s*style \+= ['"]opacity:([\d.]+)/);
  if (m) {
    assert(parseFloat(m[1]) >= 0.65, `dim opacity=${m[1]} 太低，导致文字难以辨认`);
  } else {
    // 尝试找到另一种写法
    const m2 = html.match(/opacity:(0\.\d+)/g) || [];
    const tooLow = m2.find(v => parseFloat(v.split(':')[1]) < 0.65);
    assert(!tooLow, `发现过低的 opacity: ${tooLow}`);
  }
});

// ─── 3. 字体大小调节功能 ───────────────────────────────────────────────────────

test('存在字体放大按钮 (A+)', () => {
  assert(html.includes('font-inc') || (html.includes('A+') && html.includes('font')),
    '未找到字体放大按钮');
});

test('存在字体缩小按钮 (A-)', () => {
  assert(html.includes('font-dec') || html.includes('A-'),
    '未找到字体缩小按钮');
});

test('字体大小使用 CSS 变量控制', () => {
  assert(html.includes('--ui-font-size') || html.includes('--font-size'),
    '字体大小未使用 CSS 变量，无法动态调节');
});

// ─── 4. 视图切换 ──────────────────────────────────────────────────────────────

test('存在聊天视图切换标签', () => {
  assert(html.includes('tab-chat') || (html.includes('tab') && html.includes('聊天')),
    '未找到聊天视图标签');
});

test('存在文件视图切换标签', () => {
  assert(html.includes('tab-files') || (html.includes('tab') && html.includes('文件')),
    '未找到文件视图标签');
});

test('存在独立的文件视图面板 (#view-files)', () => {
  assert(html.includes('id="view-files"') || html.includes("id='view-files'"),
    '未找到文件视图面板 #view-files');
});

// ─── 5. 文件内容阅读 ──────────────────────────────────────────────────────────

test('存在文件内容显示区域', () => {
  assert(html.includes('file-content-body') || html.includes('file-content'),
    '未找到文件内容显示区域');
});

test('支持 Markdown 渲染', () => {
  assert(html.includes('renderMarkdown') || html.includes('md-view'),
    '未实现 Markdown 渲染功能');
});

test('支持代码文件显示 (.code-view)', () => {
  assert(html.includes('code-view') || html.includes('code-block'),
    '未实现代码文件显示功能');
});

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────');
console.log(`结果: ${passed} 通过  /  ${failed} 失败  /  共 ${passed + failed} 项\n`);

if (failed > 0) {
  console.log('❌ 需要修复以下问题:');
  results.filter(r => !r.ok).forEach(r => console.log(`   • ${r.name}`));
  process.exit(1);
} else {
  console.log('✅ 所有测试通过！');
}
