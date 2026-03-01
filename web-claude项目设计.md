# web-claude 项目设计文档

这份文档面向编程新手，完整讲解 web-claude 的实现思路、用到的工具和关键代码细节，帮助你理解并维护这个项目。

---

## 一、这个项目是干什么的

**目标**：让你能在手机或任意浏览器上使用 Claude Code（原本只能在终端里用的命令行工具）。

**核心思路**：在服务器上运行一个 Node.js 程序，它在后台真实地启动了 Claude Code 的终端进程，然后把终端的输入输出通过网络实时传输给浏览器显示。浏览器里用一个模拟终端来呈现，让你感觉好像直接在终端里操作一样。

```
你的手机浏览器  ←──WebSocket──→  Node.js 服务器  ←──PTY──→  Claude Code 进程
```

---

## 二、文件结构总览

```
web-claude/
├── server.js          # 后端核心，Node.js 服务器
├── server.sh          # 服务器管理脚本（启动/停止/日志等）
├── manage_users.sh    # 用户管理脚本（添加/删除/改密码）
├── package.json       # 项目依赖声明
├── users.json         # 用户数据库（自动生成）
├── .jwt_secret        # JWT 签名密钥（自动生成，勿泄露）
├── .server.conf       # 服务配置（端口等）
├── .server.pid        # 记录服务进程ID（自动生成）
├── server.log         # 服务日志
├── hooks/
│   └── check-path.sh  # Claude PreToolUse hook，拦截越权文件访问
└── public/
    ├── index.html     # 登录页
    └── chat.html      # 主界面（终端 + 文件浏览器）
```

**全局 Claude Code 配置**（不在本目录内，但与本项目强关联）：
```
/root/.claude/settings.json   # 注册 PreToolUse hook，作用于所有 Claude 会话
```

---

## 三、后端：server.js 详解

### 3.1 用到的库（依赖）

`package.json` 中声明了所有依赖，运行 `npm install` 后会下载到 `node_modules/` 目录。

| 库名 | 作用 | 类比 |
|------|------|------|
| `express` | HTTP 服务器框架，处理网页请求 | 相当于一个"接线员"，按URL分发请求 |
| `ws` | WebSocket 服务器，实现实时双向通信 | 电话线，可以随时互相发消息 |
| `node-pty` | 创建伪终端（PTY），在 Node.js 里运行终端程序 | 让 Node.js 能"假装"是一个真正的终端 |
| `jsonwebtoken` | 生成和验证 JWT 令牌（登录凭证） | 类似于印章，验证你身份的"通行证" |
| `bcryptjs` | 对密码加密存储 | 把密码变成乱码存起来，防止数据库泄露后密码被破解 |
| `uuid` | 生成唯一ID | 每个会话分配一个不重复的ID |
| `crypto` `fs` `path` `http` | Node.js 内置模块，不需要安装 | 随机数、文件读写、路径处理、HTTP服务 |
| `mammoth` | 将 .docx 文件转为 HTML | 纯 JS 实现，无需安装 LibreOffice |
| `xlsx`（SheetJS） | 读取 .xlsx/.xls/.csv 文件 | 生成 HTML 表格供浏览器展示 |
| `diff` | 生成和应用 unified diff patch | 客户端发增量 patch，服务端 apply 到磁盘文件 |

### 3.2 启动流程

```
server.js 启动
  ↓
读取/生成 JWT 密钥（.jwt_secret）
  ↓
Express 创建 HTTP 服务器
  ↓
WebSocket 服务器附加在同一个 HTTP 服务器上
  ↓
监听端口（默认3000），等待连接
```

**为什么 HTTP 和 WebSocket 共用同一个端口？**

`ws` 库的 `WebSocketServer` 可以附加到已有的 HTTP 服务器上，浏览器连接 `/ws` 路径时，服务器识别出这是 WebSocket 握手请求，自动升级协议。普通的 HTTP 请求（加载页面、API调用）还是走 HTTP。

### 3.3 用户系统

**密码存储方式**（`bcryptjs`）：

```javascript
// 添加用户时（manage_users.sh 调用 admin_helper.js）
const hash = await bcrypt.hash('用户输入的密码', 10);  // 10 是加密强度
// 存入 users.json: { username: "tom", passwordHash: "$2a$10$...", workDir: "..." }

// 登录验证时
const valid = await bcrypt.compare('用户输入的密码', user.passwordHash);
// 即使知道 hash，也无法反推出原始密码
```

**JWT 令牌**（`jsonwebtoken`）：

登录成功后，服务器生成一个 JWT 令牌（一串加密字符串）发给浏览器，浏览器存在 `localStorage` 里。之后每次请求都带上这个令牌，服务器验证令牌合法且未过期，就允许访问。

```javascript
// 生成令牌（登录时）
const token = jwt.sign(
  { username: 'tom', sessionId: 'uuid-xxxx', workDir: '/home/tom' },
  JWT_SECRET,      // 用密钥签名，别人伪造不了
  { expiresIn: '24h' }  // 24小时后过期
);

// 验证令牌（每次API请求时）
const payload = jwt.verify(token, JWT_SECRET);
// 如果令牌被篡改或过期，这里会抛出异常
```

### 3.4 PTY（伪终端）：核心机制

这是整个项目最关键的部分。`node-pty` 让服务器能在 Node.js 里启动一个真正的终端进程（Claude Code），并双向传输数据。

```javascript
const term = pty.spawn('bash', ['-c', `cd "${workDir}" && claude`], {
  name: 'xterm-256color',  // 告诉程序终端类型（影响颜色显示）
  cols: 220,               // 终端宽度（字符数）
  rows: 50,                // 终端高度（行数）
  cwd: workDir,            // 工作目录
  env: childEnv,           // 环境变量
});

// 收到 Claude 的输出 → 广播给所有连接的浏览器
term.onData(data => {
  broadcast(session, { type: 'output', data });
});

// 用户在浏览器按键 → 写入终端
term.write(msg.data);

// 用户调整浏览器窗口大小 → 同步给终端
term.resize(cols, rows);
```

**PTY 和普通进程的区别**：普通子进程（`child_process.spawn`）没有终端上下文，很多终端程序（包括 Claude Code）检测到不在终端里就会改变行为。PTY（伪终端）模拟了一个完整的终端设备，程序完全以为自己在真终端里运行。

### 3.5 会话（Session）管理

```javascript
// 会话结构
const session = {
  term,              // PTY 进程对象
  buffer: '',        // 滚动缓冲区（最多100KB），新用户连接时回放历史
  clients: Set<ws>,  // 当前连接这个会话的所有 WebSocket 连接
  workDir,           // 工作目录
  lastActivity,      // 最后活跃时间
  alive: true,       // 进程是否还在运行
  suppressPaths: new Set(),  // 抑制自写触发 file_changed 的路径集合（200ms 窗口）
};
```

**为什么有 buffer？** 你断网重连后，能看到之前的终端内容，而不是空白屏幕。

**闲置清理**：每60秒检查一次，如果一个会话超过30分钟没人连且没有活动，自动杀掉 PTY 进程，释放资源。

### 3.6 HTTP API 接口

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/login` | POST | 验证用户名密码，返回 JWT 令牌 |
| `/api/files?path=...` | GET | 列出指定目录的文件和子目录 |
| `/api/file?path=...` | GET | 按文件类型分流：文本返回内容+mtime，docx/xlsx/csv 返回 HTML，pdf 返回 rawUrl，.doc 返回 unsupported |
| `/api/file/raw?path=...` | GET | 流式传输 PDF 文件原始字节（仅限 .pdf） |
| `/api/file` | POST | 写文件：body `{path, patch?, content?, mtime?}`；patch 方式做 mtime+diff 双重冲突检测；content 方式强制覆盖；返回 `{ok, mtime}` 或 `{conflict:true, currentContent, currentMtime}` |

所有 `/api/*` 请求都需要在 HTTP Header 中携带令牌：
```
Authorization: Bearer <token>
```

### 3.7 WebSocket 通信协议

浏览器和服务器之间用 JSON 格式的消息通信，每条消息有一个 `type` 字段：

**浏览器 → 服务器：**

| type | 含义 | 额外字段 |
|------|------|---------|
| `auth` | 发送令牌认证 | `token` |
| `input` | 用户输入的文字 | `data`（字符串，不含回车，回车单独用 `key:enter` 发送） |
| `key` | 特殊按键 | `key`（如 `ctrl_c`、`enter`） |
| `resize` | 终端尺寸变化 | `cols`、`rows` |
| `watch_file` | 开始监听文件变化 | `path`（绝对路径，仅限 workDir 内） |
| `unwatch_file` | 停止监听文件变化 | `path` |

**服务器 → 浏览器：**

| type | 含义 | 额外字段 |
|------|------|---------|
| `auth_ok` | 认证成功 | `username` |
| `output` | 终端输出数据 | `data`（含ANSI转义序列） |
| `exit` | Claude进程退出 | `code`（退出码） |
| `error` | 错误信息 | `message` |
| `file_changed` | 被监听的文件被外部（Agent）修改 | `path` |

---

## 四、前端：chat.html 详解

整个前端是一个单文件 HTML，没有使用 React/Vue 等框架，用原生 JavaScript（Vanilla JS）写的。

### 4.1 用到的第三方库（CDN 引入）

**xterm.js** - 浏览器里的终端模拟器：
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
```
xterm.js 能解析 ANSI 转义序列（终端颜色、光标移动等控制码），把它们正确渲染成带颜色的终端界面。`FitAddon` 负责让终端自动适应容器大小。

**highlight.js** - 代码语法高亮：
```html
<link rel="stylesheet" href="...atom-one-dark.min.css">
<script src="...highlight.min.js"></script>
```
在文件浏览器中查看代码文件时，给不同语言的关键字上色。

### 4.2 CSS 变量系统

所有颜色、字号等都定义在 `:root` 里，方便统一修改主题：

```css
:root {
  --bg:           #1a1b26;   /* 主背景色（深蓝黑） */
  --bg2:          #24283b;   /* 次背景（略浅，用于header/toolbar） */
  --bg3:          #1e2030;   /* 第三层背景（代码区域） */
  --border:       #414868;   /* 边框颜色 */
  --text:         #c0caf5;   /* 主文字颜色 */
  --text-dim:     #787c99;   /* 次要文字（暗色） */
  --accent:       #7aa2f7;   /* 强调色（蓝色） */
  --danger:       #f7768e;   /* 危险操作（红色） */
  --success:      #9ece6a;   /* 成功状态（绿色） */
  --warn:         #e0af68;   /* 警告（橙色） */
  --file-font-size: 15px;    /* 文件视图字体大小，可由A+/A-按钮调整 */
}
```

**如何修改主题色**：只需改这里的颜色值，整个页面的配色会跟着变。

### 4.3 布局结构

```
body（flex 竖排）
├── #header（固定高度，顶部栏）
│   ├── 标题
│   ├── 标签切换（聊天/文件）
│   ├── 字体大小控制（A- / A+）
│   └── 状态指示 + 退出按钮
│
├── #view-chat（聊天视图，flex 竖排）
│   ├── #terminal-wrap（终端区域，占据剩余空间）
│   ├── #toolbar（快捷键工具栏）
│   └── #input-area（输入框 + 发送按钮）
│
└── #view-files（文件视图，flex 横排）
    └── #file-split（flex 横排）
        ├── #file-tree-panel（文件树，固定宽度，可拖动调整）
        ├── #resize-handle（6px 拖动分隔条，树↔内容区）
        └── #file-content-area（内容区，flex 横排，position:relative）
            ├── #pane-left（左栏，flex:1，默认全宽）
            │   ├── .pane-header（只读/编辑双模式 header）
            │   ├── .pane-banner（Agent 写入警告条）
            │   └── .pane-body（文件内容渲染区）
            ├── #pane-divider（5px 拖动分隔条，左↔右栏，默认隐藏）
            └── #pane-right（右栏，默认隐藏；含 ✕ 关闭按钮）
                ├── .pane-header
                ├── .pane-banner
                └── .pane-body
```

**`flex: 1`** 是 CSS Flexbox 的属性，意思是"占据父容器的全部剩余空间"。终端区域、文件内容区域都用了这个，所以能自动填满屏幕。

### 4.4 终端特殊按键处理

xterm.js 默认把 Ctrl+C 当作 SIGINT（中断信号）发给 PTY，导致用户无法用 Ctrl+C 复制终端里的文字，Ctrl+V 也无法粘贴剪贴板内容。通过 `attachCustomKeyEventHandler` 拦截，在应用层做分流：

```javascript
term.attachCustomKeyEventHandler(evt => {
  if (evt.type !== 'keydown') return true;

  if (evt.ctrlKey && evt.key === 'c') {
    if (term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;   // 有选中文字 → 复制，阻止 xterm 将 Ctrl+C 发给 PTY
    }
    return true;      // 无选中文字 → 正常发 SIGINT
  }

  if (evt.ctrlKey && evt.key === 'v') {
    navigator.clipboard.readText().then(text => {
      if (text && ws && ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'input', data: text }));
    }).catch(() => {});
    return false;     // 粘贴剪贴板内容到终端，阻止 xterm 默认行为
  }

  if (evt.ctrlKey && (evt.key === '1' || evt.key === '2' || evt.key === '3')) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'input', data: evt.key }));   // 先发数字
      ws.send(JSON.stringify({ type: 'key',  key: 'enter' }));     // 再单独发 Enter
    }
    return false;     // 快速选项：Ctrl+1/2/3 直接发送对应数字并回车
  }

  return true;        // 其他按键交给 xterm 处理
});
```

`attachCustomKeyEventHandler` 的返回值含义：`false` 表示"我自己处理了，xterm 不要管"，`true` 表示"xterm 按默认逻辑处理"。

**Ctrl+1/2/3 的用途**：Claude 经常以编号列表（1. 选项A / 2. 选项B）呈现选择，桌面端用 Ctrl+1/2/3 可跳过手动输入直接选定，等效于打了数字再回车。

> **重要**：数字和回车必须作为两次独立的 PTY write 发送，合并成 `'1\r'` 单次写入时 Claude 的 readline 不会触发行提交。因此实现上先发 `{ type: 'input', data: '1' }`，再发 `{ type: 'key', key: 'enter' }`。

### 4.5 Enter 模式可切换

桌面用户习惯 Enter 发送消息，手机用户则更习惯 Enter 换行、点按钮发送。为此在 header 加了一个切换按钮，偏好存入 `localStorage`：

```javascript
let enterSend = localStorage.getItem('cc_enter_send') !== 'false'; // 默认 true

function applyEnterMode() {
  if (enterSend) {
    btn.textContent   = '↵ 发送';
    input.placeholder = '输入消息…（Enter 发送，Shift+Enter 换行）';
  } else {
    btn.textContent   = '↵ 换行';
    input.placeholder = '输入消息…（Enter 换行，Ctrl+Enter 发送）';
  }
}

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const shouldSend = enterSend ? !e.shiftKey : e.ctrlKey;
    if (shouldSend) { e.preventDefault(); sendText(); }
  }
});
```

| 模式 | Enter | 组合键 |
|------|-------|--------|
| ↵ 发送（默认） | 发送消息 | Shift+Enter 换行 |
| ↵ 换行（手机友好）| 插入换行 | Ctrl+Enter 发送 |

### 4.6 字体大小控制

```javascript
const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20];  // 可选的字号档位
let fontIdx = 3;  // 默认 15px

function applyFontSize() {
  const sz = FONT_SIZES[fontIdx];
  term.options.fontSize = sz;                                          // 更新终端字体
  document.documentElement.style.setProperty('--file-font-size', sz + 'px');  // 更新文件视图字体
  localStorage.setItem('cc_font_size', sz);                            // 记住设置
  setTimeout(() => { fitAddon.fit(); sendResize(); }, 50);             // 重新计算终端尺寸
}
```

字号设置存在浏览器的 `localStorage` 里，刷新页面后还会恢复。

### 4.7 可拖动分隔条

```javascript
const resizeHandle  = document.getElementById('resize-handle');
const fileTreePanel = document.getElementById('file-tree-panel');

function startResize(clientX) {
  isResizing   = true;
  resizeStartX = clientX;               // 记录拖动起始X坐标
  resizeStartW = fileTreePanel.offsetWidth;  // 记录起始宽度
}

function doResize(clientX) {
  const newW = Math.max(60, Math.min(
    resizeStartW + clientX - resizeStartX,  // 初始宽度 + 移动距离
    window.innerWidth * 0.75               // 最大不超过屏幕75%
  ));
  fileTreePanel.style.width = newW + 'px';
}
```

同时监听了鼠标事件（`mousedown/mousemove/mouseup`）和触摸事件（`touchstart/touchmove/touchend`），所以手机和桌面都能用。

### 4.8 终端与 WebSocket 联动

```javascript
// 1. 建立 WebSocket 连接
ws = new WebSocket(`ws://${location.host}/ws`);

// 2. 连接成功，先发送认证
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));

// 3. 收到服务器消息
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'output') {
    term.write(msg.data);  // 把终端输出写入 xterm.js，它负责渲染
  }
};

// 4. 用户在输入框按发送：文字和 Enter 必须拆成两条消息分别发送
ws.send(JSON.stringify({ type: 'input', data: text }));   // 先发文字内容
ws.send(JSON.stringify({ type: 'key',  key: 'enter' }));  // 再单独发 Enter
// 注意：两者合并成 text+'\r' 一次写入 PTY 时，Claude 的 readline 不会把 \r 识别为提交触发，
// 必须作为独立的第二次 PTY write 才能正确触发行提交。
```

**断线自动重连**：如果 WebSocket 断开，会自动尝试重连，间隔时间从1秒开始，每次失败翻倍，最多15秒一次。

### 4.9 文件浏览器

文件浏览分两步：

**文件树宽度可拖动调整**：

- 标题栏有 `◀` 折叠按钮和 `⟳` 刷新按钮
- 拖动 `#resize-handle` 分隔条可任意调整文件树宽度（最小可拖到 0，即完全折叠）
- 拖到 20px 以下时自动吸附到 0（完全折叠），树内容隐藏，分隔条变为 18px 宽的展开条（显示 `›` 箭头），方便触屏点击展开
- 双击分隔条：在当前宽度与 0 之间切换
- 点击 `◀` 按钮：折叠；展开时拖动分隔条或双击即可恢复
- 宽度存入 `localStorage`（`cc_tree_width`），刷新页面后恢复

```javascript
function setTreeWidth(w) {
  fileTreePanel.style.width = w + 'px';
  if (w === 0) {
    fileSplit.classList.add('tree-collapsed');   // CSS 切换展开条样式
  } else {
    fileSplit.classList.remove('tree-collapsed');
    savedTreeWidth = w;
    localStorage.setItem('cc_tree_width', w);   // 持久化
  }
}
```

**刷新按钮**：点击后重新加载当前目录，用于 Claude 修改文件后同步显示最新内容。实现方式：`loadFiles()` 每次成功后将当前路径存入 `currentDir`，刷新按钮直接调用 `loadFiles(currentDir)`。

**拖拽打开右栏**：文件条目设置了 `draggable=true`，拖到 `#file-content-area` 右半边（`clientX > rect.left + rect.width/2`）时自动唤起右栏，并在右栏加载文件；拖到左半边则在左栏打开。拖动过程中显示半透明蓝色虚线提示框（`.drop-hint.left` / `.drop-hint.right`）指示落点。

**第一步：列目录**（点击文件夹时）
```javascript
const res  = await fetch(`/api/files?path=${encodeURIComponent(dir)}`, {
  headers: { Authorization: 'Bearer ' + token }
});
const data = await res.json();
// data.entries 是文件/目录列表，渲染成 DOM 元素
```

**第二步：读文件**（点击文件时）
```javascript
const res  = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
  headers: { Authorization: 'Bearer ' + token }
});
const data = await res.json();
// data.content 是文件文本内容，根据文件类型决定如何渲染
```

**多格式渲染模式**（由服务端 `type` 字段决定）：

| 文件类型 | 服务端处理 | 前端渲染 |
|---------|---------|---------|
| `.md` | 原样返回文本 | 自定义 `renderMarkdown()` 转成 HTML |
| `.js/.py` 等代码文件 | 原样返回文本 | `highlight.js` 语法高亮 |
| 其他文本 | 原样返回文本 | 原样显示 |
| `.docx` | mammoth 转 HTML（服务端） | `<div class="docx-view">` 直接注入 |
| `.xlsx/.xls/.csv` | SheetJS 转 HTML 表格（服务端） | `<div class="table-view">` 注入，带 sticky 表头 |
| `.pdf` | 不读内容，返回 `rawUrl` | 客户端 fetch + Blob + `URL.createObjectURL()` → `<embed>` |
| `.doc` | 不支持，返回提示 | 显示"请转换为 .docx"提示 |

所有文本类文件（md/代码/纯文本）在文件头部显示"编辑"按钮，点击进入在线编辑模式。

### 4.10 在线编辑与增量同步

**设计目标**：用户能直接在浏览器里修改工作目录内的文本文件，并能感知到 Agent（Claude）对同一文件的并发写入。

**per-pane 状态工厂**（`makePaneState(paneEl)`）：

每个 pane 是独立的状态对象，由工厂函数生成。关键字段：
```javascript
{
  el, header, viewHd, editHd,    // DOM 引用
  bannerEl, body, titleEl, ...   // DOM 引用
  filePath, fileName, pdfObjUrl, // 当前已打开文件的状态
  edit: {                        // 编辑器状态
    active, filePath, fileName,
    lastSavedContent,            // 上次成功保存时的内容（用于计算 patch）
    serverMtime,                 // 上次保存后服务端返回的 mtime（冲突检测）
    autoSaveTimer,               // setInterval ID（30s 自动保存）
    saveInProgress,              // 防并发保存
    treeWasVisible,              // 进入编辑前文件树是否可见（退出时恢复）
  }
}
const paneLeft  = makePaneState(document.getElementById('pane-left'));
const paneRight = makePaneState(document.getElementById('pane-right'));
```

所有文件操作函数（`openFile`、`enterEditMode`、`exitEditMode`、`saveFile`、`autoSave`、`handleConflict`）均以 `pane` 为第一参数，在对应 pane 内完成操作，两栏互不影响。

**进入编辑模式**（`enterEditMode(pane, filePath, name, content, mtime)`）：
1. 将该 pane header 切换为编辑模式（显示保存/取消按钮、保存状态）
2. 将 pane body 替换为 `<textarea class="edit-textarea">`，内容填充磁盘文件原文
3. `requestAnimationFrame(() => { ta.setSelectionRange(0,0); ta.scrollTop=0; ta.focus(); })` 确保光标归顶而非滚动到末尾
4. 通过 WebSocket 发 `watch_file`，让服务端开始监听此文件变化
5. 启动 30s 自动保存定时器
6. 左栏进入编辑且右栏未开启时，自动隐藏文件树（`display:none`），让编辑区独占全宽

**增量保存**（`saveFile(forceContent?)`）：
```
正常保存（无 forceContent）：
  patch = Diff.createPatch(fileName, lastSavedContent, textarea.value)
  POST /api/file { path, patch, mtime: serverMtime }
  → 服务端：mtime 冲突检测 + Diff.applyPatch() + writeFileSync
  → 成功：更新 lastSavedContent + serverMtime，显示"已保存 HH:mm:ss"

强制覆盖（forceContent 传入）：
  POST /api/file { path, content: forceContent }
  → 服务端：直接 writeFileSync，无冲突检测
```

**冲突处理**（`handleConflict()`）：
- 服务端返回 `{conflict:true, currentContent, currentMtime}` 时触发
- 前端显示橙色警告条，提供两个选项：
  - "重新加载"：丢弃本地编辑，将服务端内容填入 textarea
  - "强制覆盖保存"：调用 `saveFile(localContent)` 强制写入

### 4.11 Agent 写入一致性

**问题**：用户在浏览器里编辑文件时，Claude（Agent）可能同时通过工具修改磁盘上的同一文件，导致用户下次保存时产生冲突甚至丢失数据。

**解决方案**：`fs.watch` + `suppressPaths` + 橙色警告条

**fs.watch 监听（服务端）**：
```javascript
// 每个 WS 连接有独立的 wsWatchers Map
const wsWatchers = new Map();   // path → FSWatcher

// 收到 watch_file 消息时：
const watcher = fs.watch(filePath, () => {
  if (session.suppressPaths.has(filePath)) return;   // 自写抑制，跳过
  broadcast(session, { type: 'file_changed', path: filePath });   // 通知所有客户端
});
wsWatchers.set(filePath, watcher);

// WS 断开时自动清理所有 watcher
ws.on('close', () => {
  for (const w of wsWatchers.values()) w.close();
  wsWatchers.clear();
});
```

**suppressPaths 自写抑制（服务端）**：
用户保存文件时，`POST /api/file` 在 `writeFileSync` 前后执行：
```javascript
session.suppressPaths.add(filePath);    // 加入抑制集合
fs.writeFileSync(filePath, finalContent);
setTimeout(() => session.suppressPaths.delete(filePath), 200);   // 200ms 后移除
```
这样 fs.watch 回调（约50ms 后触发）检测到路径在抑制集合里，不会广播 `file_changed`，避免用户收到自己写入的虚假冲突通知。

**客户端响应**：
```javascript
else if (msg.type === 'file_changed') {
  // 同时检查左右两栏，各自独立显示警告条
  [paneLeft, paneRight].forEach(pane => {
    if (pane.edit.active && msg.path === pane.edit.filePath) {
      showBanner(pane, 'Claude 已修改此文件，建议保存后重新加载');
    }
  });
}
```

**完整一致性场景表**：

| 场景 | 行为 |
|------|------|
| 用户保存文件 | suppressPaths 抑制 200ms，fs.watch 回调被跳过，客户端不收到误报 |
| Claude 修改用户正在编辑的文件 | fs.watch 触发 → broadcast file_changed → 客户端显示橙色警告条 |
| 用户选"重新加载" | 丢弃本地编辑，服务端内容覆盖 textarea，mtime 同步 |
| 用户选"强制覆盖保存" | 发全量 content（无 mtime 校验），强制覆盖 |
| Claude 修改用户未打开的文件 | 未建立 fs.watch，无影响 |
| WS 断线重连 | auth_ok 后遍历两栏，各自重发 watch_file 恢复监听 |

### 4.12 左右双栏文件浏览

**设计目标**：同时打开两个文件并排阅读/编辑，通过拖拽手势分配左右空间。

**布局**：`#file-content-area` 采用 flex 横排，内含三个子元素：
- `#pane-left`（`flex:1`，始终可见）
- `#pane-divider`（5px，`col-resize`，默认隐藏）
- `#pane-right`（`flex:none; width:50%`，默认隐藏）

**打开文件的三种方式**：

| 操作 | 结果 |
|------|------|
| 点击文件树中的文件 | 在左栏打开（右栏未开启时左栏全宽） |
| 拖拽文件到内容区左半边 | 在左栏打开 |
| 拖拽文件到内容区右半边 | 自动唤起右栏，在右栏打开 |

**拖拽判断逻辑**：
```javascript
fileContentArea.addEventListener('drop', e => {
  const rect    = fileContentArea.getBoundingClientRect();
  const isRight = e.clientX > rect.left + rect.width / 2;
  if (isRight) {
    if (paneRight.el.style.display === 'none') openRightPane();
    openFile(paneRight, filePath, name);
  } else {
    openFile(paneLeft, filePath, name);
  }
});
```

**pane-divider 可拖动调整宽度**（只影响右栏宽度，左栏 `flex:1` 自动填满剩余空间）：
```javascript
// 向左拖 → delta 为正 → 右栏变宽
const delta = paneDivStartX - e.clientX;
paneRight.el.style.width = newW + 'px';
```

**关闭右栏**：点击右栏 header 中的 `✕` 按钮，`closeRightPane()` 清理编辑状态、释放 PDF Object URL、隐藏右栏和分隔条。

**两栏编辑独立性**：banner、save-status、watch_file、autoSave 均按 pane 独立运作，互不干扰。

### 4.13 自制 Markdown 渲染器

项目没有引入 marked.js 等库，而是自己写了一个 `renderMarkdown()` 函数（约80行）。思路是用正则表达式依次替换各种 Markdown 语法：

```javascript
// 先保护代码块不被其他规则影响（用占位符替换）
text = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
  codeBlocks.push({ lang, code });
  return `\x00CODE${idx}\x00`;  // 占位符
});

// 然后处理各种语法
text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');   // 标题
text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');  // 加粗

// 最后把占位符换回代码块
text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
  const { lang, code } = codeBlocks[idx];
  return `<pre><code class="lang-${lang}">${code}</code></pre>`;
});
```

---

## 五、管理脚本详解

### 5.1 server.sh 服务管理

这个 Bash 脚本封装了服务器的日常操作：

```bash
./server.sh start          # 后台启动服务（nohup，关终端不会停）
./server.sh stop           # 优雅停止（先 SIGTERM，5秒无响应再 SIGKILL）
./server.sh restart        # 停止 + 启动
./server.sh status         # 查看运行状态（PID、内存、CPU）
./server.sh logs -f        # 实时查看日志
./server.sh port 8080      # 改端口（改完自动重启）
sudo ./server.sh firewall open   # 开放端口（通过 ufw）
sudo ./server.sh install-service  # 注册为系统服务（开机自动启动）
```

**PID 文件机制**：启动时把进程ID写入 `.server.pid`，停止时从中读取ID再 kill。用 `kill -0 $pid` 检测进程是否还活着（`-0` 不发任何信号，只检测进程存在与否）。

### 5.2 manage_users.sh 用户管理

```bash
./manage_users.sh add <用户名> <密码> [工作目录]   # 添加用户
./manage_users.sh del <用户名>                     # 删除用户
./manage_users.sh list                             # 列出所有用户
./manage_users.sh passwd <用户名> <新密码>         # 改密码
```

用户数据存在 `users.json`：
```json
{
  "users": [
    {
      "username": "tom",
      "passwordHash": "$2a$10$xxxxxx...",
      "workDir": "/home/tom/projects"
    }
  ]
}
```

---

## 六、数据流全程追踪

以"用户在手机上输入一条消息给 Claude"为例，完整流程如下：

```
1. 用户在输入框打字，点击「发送」

2. 浏览器 JS（文字和 Enter 分两条消息发送）：
   ws.send(JSON.stringify({ type: 'input', data: '帮我写一个Python脚本' }))
   ws.send(JSON.stringify({ type: 'key',  key: 'enter' }))

3. 服务器收到 WebSocket 消息：
   session.term.write('帮我写一个Python脚本\r')
   → 把字符写入 PTY（就像真实键盘输入）

4. Claude Code 进程收到输入（以为是用户在真终端里打字），开始思考和回复

5. Claude 生成输出（含 ANSI 颜色转义码）：
   term.onData(data => broadcast(session, { type: 'output', data }))
   → 服务器把输出广播给所有连接这个会话的 WebSocket

6. 浏览器收到：
   term.write(msg.data)
   → xterm.js 解析 ANSI 转义码，渲染成带颜色的终端内容

7. 用户在手机屏幕上看到 Claude 的回复
```

---

## 七、安全机制

### 7.1 认证与传输安全

| 机制 | 实现方式 | 防止什么 |
|------|---------|---------|
| 密码加盐哈希 | bcryptjs | 数据库泄露后密码不会直接暴露 |
| JWT 签名 | jsonwebtoken + 随机密钥 | 令牌伪造、篡改 |
| 令牌24小时过期 | jwt.sign expiresIn | 令牌长期有效的风险 |
| Bearer Token | HTTP Header Authorization | 防止令牌在URL日志里泄露 |
| 文件大小限制 | stat.size > 500KB 拒绝 | 防止读取超大文件拖垮服务器 |

### 7.2 目录访问限制：三层防护

用户登录时，其 `workDir` 被写入 JWT 令牌。此后所有文件操作都必须限定在这个目录内。

```
第一层：Web 文件 API（server.js）
  ─ 拦截 /api/files 和 /api/file 的路径穿越请求

第二层：Claude 文件工具 PreToolUse hook（check-path.sh）
  ─ 拦截 Claude 使用 Read/Write/Edit/Glob 等工具访问越权路径

第三层：Claude Bash 工具尽力检测（check-path.sh）
  ─ 检测 Bash 命令中的明显越权绝对路径（非完全可靠）
```

**第一层：`withinRoot` 函数（server.js）**

```javascript
function withinRoot(rootDir, targetPath) {
  const root   = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  // path.sep 是路径分隔符（Linux 下是 /），拼上它防止 /tourist2 被误判为 /tourist 子目录
  return target === root || target.startsWith(root + path.sep);
}
```

`/api/files` 和 `/api/file` 在处理任何路径前都调用此函数，路径在 `workDir` 外则返回 HTTP 403。同时，已在根目录时服务端返回 `parent === path`，前端据此隐藏"上级目录"按钮。

**第二层 & 第三层：PreToolUse hook（hooks/check-path.sh）**

Claude Code 提供了一个 hook 机制：每次 Claude 准备调用某个工具前，先执行指定的 Shell 脚本。脚本通过 stdin 收到 JSON 格式的工具调用信息，**退出码 2** 表示拒绝该工具调用，Claude 会收到拒绝原因并告知用户。

```
Claude 准备调用 Read("/etc/passwd")
  ↓
Claude Code 执行 check-path.sh，stdin 收到：
  {"tool_name":"Read","tool_input":{"file_path":"/etc/passwd"}}
  ↓
脚本读取 $ALLOWED_DIR（=/usr/tourist），发现 /etc/passwd 不在范围内
  ↓
输出错误信息，exit 2
  ↓
Claude Code 取消工具调用，把错误原因告诉 Claude
  ↓
Claude 回复用户"无法访问该路径"
```

hook 脚本的工作逻辑：

```bash
ALLOWED_DIR="${ALLOWED_DIR:-}"
[ -z "$ALLOWED_DIR" ] && exit 0   # 未设置时不限制（兼容开发者直接用 Claude 的场景）

INPUT="$(cat)"                     # 从 stdin 读取 JSON
TOOL="$(get_field tool_name)"      # 提取工具名

case "$TOOL" in
  Read|Write|Edit|MultiEdit)
    check_path "$(get_field tool_input.file_path)"   # 检查 file_path 字段
    ;;
  Glob)
    check_path "$(get_field tool_input.path)"        # 检查搜索起始目录
    ;;
  Bash)
    # 提取命令中的绝对路径，逐一检查（尽力检测，非完全可靠）
    ...
    ;;
esac
```

**`ALLOWED_DIR` 是怎么传进去的？**

server.js 在 PTY 启动时注入环境变量：

```javascript
const childEnv = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  ALLOWED_DIR: safeDir,    // safeDir 就是该用户的 workDir
};
term = pty.spawn('bash', ['-c', `cd "${safeDir}" && claude`], { env: childEnv, ... });
```

Claude 进程继承了这个环境变量，执行 hook 脚本时子进程也能读到它。

**hook 在哪里注册？**

在 `/root/.claude/settings.json` 里：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Write|Edit|MultiEdit|NotebookRead|NotebookEdit|Glob|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /usr/code/SkillFrame/web-claude/hooks/check-path.sh"
          }
        ]
      }
    ]
  }
}
```

`matcher` 是正则表达式，匹配工具名。这里覆盖了所有文件相关工具和 Bash。

### 7.3 Bash 工具的固有局限

Bash 工具无法被 hook 完全可靠地封锁，因为用户可以绕过直接路径检测：

```bash
# hook 能检测到（有明显绝对路径）：
cat /etc/passwd

# hook 检测不到（用变量或 cd 绕过）：
SECRET=/etc/passwd && cat $SECRET
cd /etc && cat passwd
```

如果你的场景需要彻底隔离，有两个更根本的方案：

| 方案 | 做法 | 强度 |
|------|------|------|
| 禁用 Bash 工具 | 在 server.js 中将 `claude` 改为 `claude --disallowedTools Bash` | 高，彻底没有 Bash |
| 容器隔离 | 每个用户会话在独立 Docker 容器里运行，容器只挂载该用户目录 | 最高，OS 级隔离 |

---

## 八、常见维护操作

### 修改界面颜色

在 `chat.html` 的 `:root { }` 里改 CSS 变量值，保存后刷新浏览器即可。

### 添加新的快捷键按钮

toolbar 按钮有两种类型，根据用途选择：

**类型一：控制字符（`data-key`）**，适用于方向键、Ctrl+C 等：
```html
<button class="tbtn" data-key="ctrl_r" title="重新运行">↺ 重新运行</button>
```
然后在 `server.js` 的 `KEY_MAP` 里加上对应的 PTY 转义序列：
```javascript
ctrl_r: '\x12',
```

**类型二：文字命令（`data-text`）**，适用于数字选项、slash 命令等：
```html
<button class="tbtn" data-text="/help" title="帮助">/help</button>
```
无需修改 `server.js`——前端直接发 `{ type: 'input', data: '/help' }` + `{ type: 'key', key: 'enter' }` 两段式，与用户手动输入完全一致。

> **为什么要两段式？** Claude 的 readline 要求文字和 Enter 必须是两次独立的 PTY write 才能正确触发行提交，合并成 `'/help\r'` 单次写入不生效。

**toolbar 按钮的两种发送机制**：

| 属性 | 适用场景 | 发送方式 |
|------|---------|---------|
| `data-key="up"` | 方向键、Ctrl+C 等控制字符 | `{ type: 'key', key: 'up' }` → 服务端查 KEY_MAP 写入 PTY |
| `data-text="1"` | 文字内容（数字、slash 命令等）| `{ type: 'input', data: '1' }` + `{ type: 'key', key: 'enter' }` 两段式 |

`data-text` 机制与用户手动在输入框发送完全一致，能正确触发 Claude readline 的行提交。`data-key` 只用于不需要 readline 处理的控制字符。

**已内置的快捷按钮**：`1` `2` `3`（选择编号选项）、`/clear`（清除上下文）、`/usage`（查看用量）均使用 `data-text`。桌面端 `Ctrl+1/2/3` 等效于点击数字按钮，同样走两段式发送。

### 添加新的 API 接口

在 `server.js` 里参照现有接口模式：
```javascript
app.get('/api/你的路径', requireAuth, (req, res) => {
  // req.authPayload.username 是当前用户
  // req.query.xxx 是 URL 参数
  res.json({ 你的数据 });
});
```

### 查看错误日志

```bash
./server.sh logs -f    # 实时跟踪
./server.sh logs 200   # 最近200行
```

### 重启服务（修改了 server.js 后必须重启）

```bash
./server.sh restart
```

前端 HTML 文件（`public/` 目录）修改后不需要重启，刷新浏览器就能看到效果。

---

## 九、技术关键词速查

| 词汇 | 解释 |
|------|------|
| **Node.js** | 在服务器端运行 JavaScript 的环境 |
| **Express** | Node.js 的 Web 框架，简化 HTTP 服务开发 |
| **WebSocket** | 一种网络协议，建立后可双向实时传消息，不像 HTTP 每次都要重新请求 |
| **PTY / 伪终端** | 模拟真实终端设备的软件接口，让程序以为自己在终端里运行 |
| **ANSI 转义序列** | 终端里控制颜色、光标移动的特殊字符序列，如 `\x1b[31m` 表示红色 |
| **JWT** | JSON Web Token，一种用于身份认证的加密令牌格式 |
| **bcrypt** | 专门用于密码哈希的算法，比 MD5/SHA 更安全 |
| **CDN** | 内容分发网络，从互联网上直接引入第三方库（如 xterm.js）而无需本地安装 |
| **localStorage** | 浏览器本地存储，刷新页面不丢失，用于保存登录令牌和字体大小偏好 |
| **Flexbox** | CSS 布局方式，用 `display: flex` 开启，让元素灵活排列和填充空间 |
| **nohup** | Linux 命令，让进程在你退出终端后继续运行 |
| **systemd** | Linux 系统服务管理器，`install-service` 命令把服务注册进去后，系统重启会自动拉起 |
| **PreToolUse hook** | Claude Code 的钩子机制，在工具调用执行前触发指定脚本，脚本退出码 2 可取消调用 |
| **路径穿越（Path Traversal）** | 安全漏洞：通过 `../` 等方式绕出限定目录，访问到系统其他文件 |
| **环境变量** | 进程运行时携带的一组键值对（如 `ALLOWED_DIR=/usr/tourist`），子进程会继承父进程的环境变量 |
| **exit 2** | Shell 脚本的退出码，Claude Code 约定退出码 2 表示"拒绝该工具调用" |
| **unified diff / patch** | 文本文件的增量描述格式（`diff -u` 输出），只包含变化的行，比传全文节省带宽 |
| **fs.watch** | Node.js 内置 API，监听文件系统事件（文件修改、重命名等） |
| **suppressPaths** | 本项目自定义机制：用户保存时暂时抑制自写触发的 file_changed 广播，防止虚假冲突通知 |
| **Object URL** | 浏览器将 Blob/File 对象映射为 `blob:` 协议的临时 URL，可用于 `<embed>` 等标签加载本地数据 |
