/*
 * 无障碍配色测试：node tests/a11y.test.js
 * 从 style.css 读取设计令牌，校验关键前景 / 背景组合达到 WCAG AA：
 *   - 普通文本 ≥ 4.5:1
 *   - 大号数字 / 图标 ≥ 3:1
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

let passed = 0;
const failures = [];
const report = [];

function ok(condition, message) {
  if (condition) {
    passed++;
  } else {
    failures.push(message);
  }
}

function readTokens(startIndex) {
  const tokens = {};
  const end = CSS.indexOf('}', startIndex);
  const block = CSS.slice(startIndex, end);
  const re = /--([\w-]+):\s*([^;]+);/g;
  let match;
  while ((match = re.exec(block))) {
    const value = match[2].trim();
    if (value.indexOf('var(') === 0) continue;
    tokens[match[1]] = value;
  }
  return tokens;
}

const lightRoot = CSS.indexOf(':root {');
const light = readTokens(lightRoot);
const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
const darkRoot = CSS.indexOf(':root', darkStart);
const dark = readTokens(darkRoot);

/* ---------- 颜色工具 ---------- */

function parseColor(value) {
  if (typeof value !== 'string') throw new Error('非颜色值: ' + value);
  const hex = value.trim();
  let match = hex.match(/^#([0-9a-f]{6})$/i);
  if (match) {
    return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
  }
  match = hex.match(/^#([0-9a-f]{3})$/i);
  if (match) {
    return match[1].split('').map((ch) => parseInt(ch + ch, 16));
  }
  match = hex.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (match) {
    const rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
    rgb.alpha = match[4] === undefined ? 1 : Number(match[4]);
    return rgb;
  }
  throw new Error('无法解析颜色: ' + value);
}

function blend(foreground, background) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const alpha = fg.alpha === undefined ? 1 : fg.alpha;
  const out = [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha)));
  out.alpha = 1;
  return out;
}

function relativeLuminance(rgb) {
  const channels = rgb.slice(0, 3).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const fg = parseColor(foreground);
  const fgColor = fg.alpha === undefined || fg.alpha === 1 ? fg : blend(foreground, background);
  const bg = parseColor(background);
  const bgColor = bg.alpha === undefined || bg.alpha === 1 ? bg : blend(background, '#ffffff');
  const l1 = relativeLuminance(fgColor);
  const l2 = relativeLuminance(bgColor);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* ---------- 断言 ---------- */

function checkPair(themeName, tokens, fgName, bgName, minRatio, note) {
  const fg = fgName.indexOf('#') === 0 ? fgName : tokens[fgName];
  const bg = bgName.indexOf('#') === 0 ? bgName : tokens[bgName];
  if (!fg || !bg) {
    ok(false, themeName + ': 缺少颜色令牌 ' + (fg ? bgName : fgName));
    return;
  }
  const ratio = contrast(fg, bg);
  const label = themeName + ' ' + fgName + ' on ' + bgName + ' = ' + ratio.toFixed(2) + ':1 (需 ≥ ' + minRatio + ')';
  report.push('  ' + label + (note ? '  ' + note : ''));
  ok(ratio >= minRatio, label);
}

/* 半透明令牌在组件里的实际背景：叠加在 surface / bg 上 */
function addCompositeChecks(themeName, tokens) {
  ['surface', 'bg'].forEach((baseName) => {
    const base = tokens[baseName];
    if (!tokens.fill) return;
    const fillBg = blend(tokens.fill, base);
    const fillHex = '#' + fillBg.map((v) => v.toString(16).padStart(2, '0')).join('');
    checkPair(themeName, tokens, 'text-secondary', fillHex, 4.5, '(填充背景)');
    checkPair(themeName, tokens, 'text-tertiary', fillHex, 4.5, '(填充背景)');
    checkPair(themeName, tokens, 'blue', fillHex, 4.5, '(填充背景)');

    const redBg = blend(tokens['red-tint'], base);
    const redHex = '#' + redBg.map((v) => v.toString(16).padStart(2, '0')).join('');
    checkPair(themeName, tokens, 'red', redHex, 4.5, '(冲突底色)');

    const blueBg = blend(tokens['blue-tint'], base);
    const blueHex = '#' + blueBg.map((v) => v.toString(16).padStart(2, '0')).join('');
    checkPair(themeName, tokens, 'blue', blueHex, 3, '(选中底色，大号数字)');
  });
}

console.log('无障碍配色测试');
console.log('  浅色主题：' + Object.keys(light).length + ' 个颜色令牌，深色主题：' + Object.keys(dark).length + ' 个');

function runTheme(themeName, tokens) {
  checkPair(themeName, tokens, 'text', 'surface', 7);
  checkPair(themeName, tokens, 'text', 'bg', 7);
  checkPair(themeName, tokens, 'text-secondary', 'surface', 4.5);
  checkPair(themeName, tokens, 'text-secondary', 'bg', 4.5);
  checkPair(themeName, tokens, 'text-tertiary', 'surface', 4.5);
  checkPair(themeName, tokens, 'text-tertiary', 'bg', 4.5);
  checkPair(themeName, tokens, 'blue', 'surface', 4.5);
  checkPair(themeName, tokens, 'blue', 'bg', 4.5);
  checkPair(themeName, tokens, 'red', 'surface', 4.5);
  checkPair(themeName, tokens, 'red', 'bg', 4.5);
  checkPair(themeName, tokens, 'orange', 'surface', 3);
  checkPair(themeName, tokens, 'green', 'surface', 3);
  checkPair(themeName, tokens, '#ffffff', 'blue-solid', 4.5, '(主按钮文字)');
  checkPair(themeName, tokens, 'toast-text', 'toast-bg', 4.5, '(Toast)');
  addCompositeChecks(themeName, tokens);
}

runTheme('浅色', light);
runTheme('深色', dark);

console.log(report.join('\n'));
console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
if (failures.length) {
  console.log('\n失败项：\n- ' + failures.join('\n- '));
  process.exitCode = 1;
}
