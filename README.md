# 数独 · Sudoku

一个完全离线、可以安装到桌面 / 主屏幕的数独游戏。支持 **4×4**、**6×6**、**9×9** 三种棋盘，以及 **简单 / 中等 / 困难** 三种难度。

> 🌐 **在线试玩 / 安装**：<https://carloswuwu.github.io/sudoku/>

![游戏截图](screenshot.png)

## 开始游戏

任选一种方式：

1. **打开在线版** <https://carloswuwu.github.io/sudoku/>，无需安装，手机 / 平板 / 电脑浏览器都能直接玩。
2. **安装成 App**（推荐）：在 Chrome / Edge 中打开上面的网址，点击地址栏右侧的「安装」图标，或菜单 →「安装 数独」；iPhone / iPad 用 Safari 打开后点「分享」→「添加到主屏幕」；Android Chrome 菜单 →「安装应用」。安装后是一个独立的全屏应用窗口，即使离线也能玩。
3. **双击桌面上的「数独」快捷方式**（Windows，本机版本）。
4. 双击本文件夹里的 `play-sudoku.bat`。
5. 直接双击 `index.html`，用任意浏览器打开。

在线版首次打开后会把游戏缓存到本地（Service Worker），之后断网也能继续玩；进度保存在浏览器本地，关闭后再打开会接着玩。

## 怎么玩

- 点击棋盘上的空格选中它，然后按键盘数字键，或点击下方的数字键盘填入数字。
- 每一行、每一列、每一个粗线围成的宫格里，数字 1–N 都要恰好出现一次：
  - 4×4：每宫 2×2
  - 6×6：每宫 2 行 × 3 列
  - 9×9：每宫 3×3
- 填入的数字如果与**同行、同列或同宫**已有的数字重复，会标红并累计「错误」次数（所有发生冲突的格子都会标红，不影响继续游戏）。
- 没有冲突的数字不会被提示对错，需要自己推理；只有整盘填满且没有任何冲突才算完成。
- 点击「新游戏」可以随时切换棋盘尺寸和难度。
- 倒计时可以暂停；完成整盘后会显示成绩单。

## 快捷键

| 按键 | 功能 |
| --- | --- |
| 数字键 `1` – `9` | 填入数字（按当前棋盘尺寸取有效数字） |
| `Backspace` / `Delete` | 擦除当前格 |
| `↑` `↓` `←` `→` | 移动选中的格子 |
| `N` | 切换笔记（候选数）模式 |
| `Ctrl` + `Z` | 撤销 |
| `H` | 提示（自动填入一个正确数字） |
| `P` | 暂停 / 继续 |
| `Esc` | 暂停时继续 / 关闭弹窗 |

## 功能特点

- 简洁的 Apple 风格界面，自动跟随系统浅色 / 深色模式，手机、平板、电脑都适配。
- **PWA 支持**：可安装到桌面 / 主屏幕，独立窗口运行，并支持离线游玩。
- 三种棋盘尺寸 × 三种难度，全部由程序随机生成，**保证每道题只有唯一解**。
- 笔记、撤销（最多 200 步）、擦除、提示、暂停、计时、错误计数。
- 高亮当前行 / 列 / 宫，以及相同数字，方便推理。
- 自动保存 / 恢复进度，自动记住上次的棋盘尺寸与难度。
- 无第三方依赖、无网络请求（在线版仅首次加载需要网络）。

## 安装为 App（PWA）说明

游戏包含 `manifest.webmanifest`、Service Worker 和完整尺寸的应用图标，满足浏览器安装条件：

- **Chrome / Edge（桌面）**：打开在线版 → 地址栏右侧出现安装图标；或菜单 →「安装 数独」。也可以使用游戏底部的「安装 App」按钮（支持 `beforeinstallprompt` 的浏览器才会出现）。
- **iPhone / iPad（Safari）**：打开在线版 →「分享」→「添加到主屏幕」。
- **Android（Chrome）**：打开在线版 → 菜单 →「安装应用」/「添加到主屏幕」。
- 安装后以 `standalone` 模式运行，没有浏览器地址栏；Service Worker 会缓存游戏资源，断网也能玩。

> 提示：Service Worker 需要 HTTPS 或 localhost，因此在线版（GitHub Pages 提供 HTTPS）支持离线；直接双击 `index.html` 的本地文件模式不支持 Service Worker，但本身不需要联网。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构 |
| `style.css` | 界面样式 |
| `sudoku-core.js` | 数独出题、求解与唯一解校验（纯逻辑） |
| `app.js` | 界面交互逻辑与 PWA 安装提示 |
| `manifest.webmanifest` | PWA 应用清单 |
| `sw.js` | Service Worker（离线缓存） |
| `icon-192.png` / `icon-512.png` | PWA 图标（512 也用于 maskable） |
| `apple-touch-icon.png` | iOS 主屏幕图标 |
| `icon.ico` | Windows 桌面快捷方式图标 |
| `play-sudoku.bat` | Windows 启动器（应用窗口模式） |
| `screenshot.png` | 游戏截图 |
| `tests/` | 开发测试（普通玩家不需要） |

## 开发与测试

核心逻辑测试（无需安装依赖）：

```bash
node tests/core.test.js
```

界面逻辑测试与真实浏览器检查（需要先安装测试依赖，并确保本机有 Edge）：

```bash
npm install --prefix tests
node tests/ui.test.js
node tests/browser-qa.js
node tests/pwa-qa.js
```

- `tests/browser-qa.js` 用无头 Edge 打开游戏、模拟点击操作，并输出桌面 / 平板 / 手机 / 深色模式截图。
- `tests/pwa-qa.js` 针对已部署的在线版检查 PWA 清单、Service Worker、安装条件，并模拟断网重新加载验证离线可用。默认检查 <https://carloswuwu.github.io/sudoku/>，可通过环境变量 `PWA_URL` 指定其他地址。
