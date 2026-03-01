'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const pty        = require('node-pty');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const mammoth    = require('mammoth');
const XLSX       = require('xlsx');
const Diff       = require('diff');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT || '3000');
const USERS_FILE      = path.join(__dirname, 'users.json');
const SECRET_FILE     = path.join(__dirname, '.jwt_secret');
const DEFAULT_WORKDIR = process.env.WORK_DIR || process.cwd();
const SESSION_TTL_MS  = 30 * 60 * 1000;   // 30 min idle → kill PTY
const MAX_BUF_BYTES   = 100 * 1024;        // 100 KB scrollback per session

// Persist JWT secret across restarts
let JWT_SECRET;
if (fs.existsSync(SECRET_FILE)) {
  JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 });
}

// ─── User helpers ─────────────────────────────────────────────────────────────

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: [] };
  }
}

function findUser(username) {
  return loadUsers().users.find(u => u.username === username) || null;
}

// ─── Session / PTY management ─────────────────────────────────────────────────

// sessionId → { term, buffer:string, clients:Set<ws>, workDir, lastActivity, alive }
const sessions = new Map();

function createSession(sessionId, workDir) {
  const safeDir = (workDir && fs.existsSync(workDir)) ? workDir : DEFAULT_WORKDIR;

  let term;
  try {
    const childEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ALLOWED_DIR: safeDir };
    delete childEnv.CLAUDECODE;
    term = pty.spawn('bash', ['-c', `cd "${safeDir.replace(/"/g, '\\"')}" && claude`], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: safeDir,
      env: childEnv,
    });
  } catch (err) {
    console.error('[pty] spawn failed:', err.message);
    return null;
  }

  const session = {
    term,
    buffer:        '',
    clients:       new Set(),
    workDir:       safeDir,
    lastActivity:  Date.now(),
    alive:         true,
    suppressPaths: new Set(),   // 抑制自写触发 file_changed 的路径集合
  };

  term.onData(data => {
    session.lastActivity = Date.now();
    session.buffer += data;
    if (session.buffer.length > MAX_BUF_BYTES) {
      session.buffer = session.buffer.slice(-MAX_BUF_BYTES);
    }
    broadcast(session, { type: 'output', data });
  });

  term.onExit(({ exitCode }) => {
    session.alive = false;
    broadcast(session, { type: 'exit', code: exitCode });
    setTimeout(() => sessions.delete(sessionId), 15000);
  });

  sessions.set(sessionId, session);
  return session;
}

function broadcast(session, msg) {
  const text = JSON.stringify(msg);
  for (const ws of session.clients) {
    if (ws.readyState === 1) ws.send(text);
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请提供用户名和密码' });
  }

  const user = findUser(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: '用户名或密码错误' });

  const sessionId = uuidv4();
  const workDir   = user.workDir || DEFAULT_WORKDIR;
  const token     = jwt.sign({ username: user.username, sessionId, workDir }, JWT_SECRET, { expiresIn: '24h' });

  const session = createSession(sessionId, workDir);
  if (!session) {
    return res.status(500).json({ error: '无法启动 Claude 进程，请检查 claude 是否在 PATH 中' });
  }

  res.json({ token });
});

// 检查 targetPath 是否在 rootDir 范围内（防止路径穿越）
function withinRoot(rootDir, targetPath) {
  const root   = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(root + path.sep);
}

// GET /api/files?path=...
app.get('/api/files', requireAuth, (req, res) => {
  const workDir = path.resolve(req.authPayload.workDir || DEFAULT_WORKDIR);
  const dir     = path.resolve(req.query.path || workDir);

  if (!withinRoot(workDir, dir)) {
    return res.status(403).json({ error: '禁止访问工作目录之外的路径' });
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: path.join(dir, e.name) }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    // 已在根目录时 parent 与 path 相同，前端据此隐藏「上级目录」按钮
    const parent = dir === workDir ? workDir : path.dirname(dir);
    res.json({ path: dir, parent, entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/file?path=...  按扩展名分流返回
app.get('/api/file', requireAuth, async (req, res) => {
  const workDir  = path.resolve(req.authPayload.workDir || DEFAULT_WORKDIR);
  const filePath = path.resolve(req.query.path || '');

  if (!withinRoot(workDir, filePath)) {
    return res.status(403).json({ error: '禁止访问工作目录之外的路径' });
  }

  try {
    const stat = fs.statSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();

    if (ext === '.pdf') {
      // PDF：不读内容，返回 raw URL 让客户端自行获取
      const rawUrl = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
      return res.json({ type: 'pdf', path: filePath, rawUrl });
    }

    if (ext === '.doc') {
      return res.json({ type: 'unsupported', path: filePath, message: '旧格式 .doc 不支持预览，请转换为 .docx' });
    }

    if (ext === '.docx') {
      if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: '文件过大（>5MB）' });
      const result = await mammoth.convertToHtml({ path: filePath });
      return res.json({ type: 'docx', path: filePath, html: result.value });
    }

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: '文件过大（>5MB）' });
      const wb   = XLSX.readFile(filePath);
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const html = XLSX.utils.sheet_to_html(ws, { id: 'sheet-table', editable: false });
      return res.json({ type: 'xlsx', path: filePath, html });
    }

    // 文本文件
    if (stat.size > 500 * 1024) return res.status(400).json({ error: '文件过大（>500KB）' });
    res.json({
      type:    'text',
      path:    filePath,
      content: fs.readFileSync(filePath, 'utf8'),
      mtime:   stat.mtimeMs,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/file/raw?path=...  流式传输原始文件（PDF）
app.get('/api/file/raw', requireAuth, (req, res) => {
  const workDir  = path.resolve(req.authPayload.workDir || DEFAULT_WORKDIR);
  const filePath = path.resolve(req.query.path || '');

  if (!withinRoot(workDir, filePath)) {
    return res.status(403).json({ error: '禁止访问工作目录之外的路径' });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') return res.status(400).json({ error: '仅支持 PDF 文件' });

  try {
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/file  写文件（patch 或强制覆盖）
app.post('/api/file', requireAuth, (req, res) => {
  const workDir  = path.resolve(req.authPayload.workDir || DEFAULT_WORKDIR);
  const { path: rawPath, patch, content, mtime } = req.body || {};

  if (!rawPath) return res.status(400).json({ error: '缺少 path 参数' });

  const filePath = path.resolve(rawPath);
  if (!withinRoot(workDir, filePath)) {
    return res.status(403).json({ error: '禁止访问工作目录之外的路径' });
  }

  try {
    const stat    = fs.statSync(filePath);
    const current = fs.readFileSync(filePath, 'utf8');

    // mtime 冲突检测（允许 100ms 误差）
    if (mtime !== undefined && Math.abs(stat.mtimeMs - mtime) > 100) {
      return res.status(409).json({ conflict: true, currentContent: current, currentMtime: stat.mtimeMs });
    }

    let finalContent;
    if (patch !== undefined) {
      const result = Diff.applyPatch(current, patch);
      if (result === false) {
        return res.status(409).json({ conflict: true, currentContent: current, currentMtime: stat.mtimeMs });
      }
      finalContent = result;
    } else if (content !== undefined) {
      finalContent = content;   // 强制覆盖
    } else {
      return res.status(400).json({ error: '缺少 patch 或 content' });
    }

    // 抑制自写触发 file_changed
    const session = sessions.get(req.authPayload.sessionId);
    if (session) session.suppressPaths.add(filePath);

    fs.writeFileSync(filePath, finalContent, 'utf8');
    const newStat = fs.statSync(filePath);

    if (session) setTimeout(() => session.suppressPaths.delete(filePath), 200);

    res.json({ ok: true, mtime: newStat.mtimeMs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未授权' });
  try {
    req.authPayload = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '令牌已过期，请重新登录' });
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const KEY_MAP = {
  up:         '\x1b[A',
  down:       '\x1b[B',
  left:       '\x1b[D',
  right:      '\x1b[C',
  enter:      '\r',
  ctrl_c:     '\x03',
  ctrl_d:     '\x04',
  ctrl_z:     '\x1a',
  ctrl_l:     '\x0c',
  backspace:  '\x7f',
  escape:     '\x1b',
  tab:        '\t',
  page_up:    '\x1b[5~',
  page_down:  '\x1b[6~',
};

wss.on('connection', ws => {
  let payload    = null;
  let session    = null;
  const wsWatchers = new Map();   // path → FSWatcher，此连接的文件监听器

  const send = msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      try {
        payload = jwt.verify(msg.token, JWT_SECRET);
      } catch {
        send({ type: 'error', message: '令牌无效，请重新登录' });
        ws.close();
        return;
      }

      session = sessions.get(payload.sessionId);
      if (!session || !session.alive) {
        session = createSession(payload.sessionId, payload.workDir || DEFAULT_WORKDIR);
        if (!session) {
          send({ type: 'error', message: '无法启动 Claude 进程' });
          ws.close();
          return;
        }
      }

      session.clients.add(ws);
      send({ type: 'auth_ok', username: payload.username });
      if (session.buffer) send({ type: 'output', data: session.buffer });
      return;
    }

    if (!payload || !session) return;

    // ── User text input ───────────────────────────────────────────────────────
    if (msg.type === 'input') {
      if (!session.alive) { send({ type: 'error', message: 'Claude 进程已退出，请刷新页面' }); return; }
      session.term.write(msg.data);
      session.lastActivity = Date.now();
    }

    // ── Special key press ─────────────────────────────────────────────────────
    else if (msg.type === 'key') {
      if (!session.alive) return;
      const seq = KEY_MAP[msg.key];
      if (seq) { session.term.write(seq); session.lastActivity = Date.now(); }
    }

    // ── Terminal resize ───────────────────────────────────────────────────────
    else if (msg.type === 'resize') {
      const { cols, rows } = msg;
      if (cols > 0 && rows > 0 && session.alive) session.term.resize(cols, rows);
    }

    // ── Watch file（客户端进入编辑模式时）────────────────────────────────────
    else if (msg.type === 'watch_file') {
      const filePath = path.resolve(msg.path || '');
      const workDir  = path.resolve(payload.workDir || DEFAULT_WORKDIR);
      if (!withinRoot(workDir, filePath)) return;
      if (wsWatchers.has(filePath)) return;   // 幂等
      try {
        const watcher = fs.watch(filePath, (eventType) => {
          if (eventType !== 'change') return;
          if (session.suppressPaths.has(filePath)) return;   // 自写抑制
          broadcast(session, { type: 'file_changed', path: filePath });
        });
        wsWatchers.set(filePath, watcher);
      } catch {}  // 文件不存在等情况静默忽略
    }

    // ── Unwatch file（客户端离开编辑模式时）──────────────────────────────────
    else if (msg.type === 'unwatch_file') {
      const filePath = path.resolve(msg.path || '');
      const watcher  = wsWatchers.get(filePath);
      if (watcher) { try { watcher.close(); } catch {} wsWatchers.delete(filePath); }
    }
  });

  ws.on('close', () => {
    if (session) session.clients.delete(ws);
    // 关闭此连接的所有文件监听器
    for (const watcher of wsWatchers.values()) { try { watcher.close(); } catch {} }
    wsWatchers.clear();
  });
});

// ─── Cleanup idle sessions ────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (s.clients.size === 0 && now - s.lastActivity > SESSION_TTL_MS) {
      console.log(`[cleanup] killing idle session ${id.slice(0,8)}...`);
      try { s.term.kill(); } catch {}
      sessions.delete(id);
    }
  }
}, 60_000);

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nClaude Code Web 已启动：http://localhost:${PORT}`);
  console.log(`添加用户：./manage_users.sh add <用户名> <密码> [工作目录]\n`);
});

process.on('SIGTERM', () => {
  for (const s of sessions.values()) { try { s.term.kill(); } catch {} }
  process.exit(0);
});
