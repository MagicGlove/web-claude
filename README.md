# Claude Code Web

在浏览器中使用 Claude Code —— 将 Claude Code CLI 包装为 Web 应用，支持手机、平板、电脑等多端访问，无需在本地安装任何客户端。

```
手机/浏览器  ←── WebSocket ──→  Node.js 服务器  ←── PTY ──→  Claude Code 进程
```

## 功能特性

- **多端访问**：任意浏览器打开即用，手机也能愉快使用 Claude Code
- **真实终端**：基于 node-pty + xterm.js，完整支持 ANSI 颜色、光标等终端特性
- **多用户隔离**：每个用户独立的工作目录和 Claude 进程，互不干扰
- **会话保持**：刷新页面不断线，断网重连自动回放历史输出
- **文件浏览器**：内置文件树，支持代码高亮、Markdown 渲染、docx/xlsx/csv/pdf 预览
- **在线编辑**：文本文件在浏览器中直接编辑，增量 patch 保存，30s 自动保存
- **左右双栏**：拖拽文件到右半区打开第二栏，可并排阅读/编辑两个文件
- **Agent 写入感知**：Agent 修改正在编辑的文件时，编辑器显示橙色警告条，支持重载或强制覆盖
- **安全沙箱**：三层目录访问控制，防止用户越权访问服务器文件

---

## 项目架构

```
web-claude/
├── server.js           # 后端核心：Express HTTP + WebSocket + PTY 管理
├── admin_helper.js     # 用户管理逻辑（供 manage_users.sh 调用）
├── manage_users.sh     # 用户管理终端脚本（增删改查）
├── server.sh           # 服务管理脚本（启停/端口/防火墙/systemd）
├── package.json        # 项目依赖
├── hooks/
│   └── check-path.sh   # Claude PreToolUse Hook：拦截越权文件访问
└── public/
    ├── index.html      # 登录页
    └── chat.html       # 主界面（终端 + 文件浏览器）
```

**运行时自动生成（已加入 .gitignore，不提交）：**

```
users.json      # 用户数据库（bcrypt 密码哈希）
.jwt_secret     # JWT 签名密钥
.server.conf    # 端口等运行配置
server.log      # 服务日志
```

### 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 后端 | Node.js + Express | HTTP 服务、REST API |
| 实时通信 | ws（WebSocket） | 浏览器与服务器双向实时通信 |
| 终端模拟 | node-pty | 在服务器上运行真实的 PTY 终端进程 |
| 认证 | jsonwebtoken + bcryptjs | JWT 令牌认证、密码安全存储 |
| 前端终端 | xterm.js | 浏览器中渲染 ANSI 终端输出 |
| 代码高亮 | highlight.js | 文件浏览器中的语法高亮 |
| 文档解析 | mammoth | .docx → HTML（纯 JS，无需 LibreOffice） |
| 表格解析 | xlsx（SheetJS） | .xlsx/.xls/.csv → HTML 表格 |
| 增量同步 | diff | 客户端生成 unified patch，服务端 apply 到磁盘 |

---

## 快速开始

### 前置要求

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) 已安装并完成认证（`claude` 命令在 PATH 中）
- 编译工具（用于 node-pty）：`apt-get install -y build-essential python3`

### 1. 安装依赖

```bash
git clone https://github.com/MagicGlove/web-claude.git
cd web-claude
npm install
```

### 2. 添加用户

```bash
./manage_users.sh add <用户名> <密码> [工作目录]

# 示例
./manage_users.sh add alice mypassword /home/alice/projects
```

### 3. 启动服务

```bash
./server.sh start          # 默认端口 3000
./server.sh start 8080     # 指定端口
```

### 4. 访问

打开浏览器访问 `http://服务器IP:3000`，使用刚才添加的账号登录。

---

## 用户管理

用户管理**只能**在服务器终端通过脚本完成，Web 界面无注册入口。

```bash
./manage_users.sh add     <用户名> <密码> [工作目录]   # 添加用户
./manage_users.sh list                                # 列出所有用户
./manage_users.sh passwd  <用户名> <新密码>            # 修改密码
./manage_users.sh workdir <用户名> <目录>              # 修改工作目录
./manage_users.sh remove  <用户名>                    # 删除用户
```

工作目录是用户登录后 Claude Code 的起始目录，Claude 的文件操作将被限制在此目录内。

---

## 服务管理

```bash
./server.sh start          # 启动（后台 nohup 运行）
./server.sh stop           # 停止
./server.sh restart        # 重启
./server.sh status         # 查看状态（PID、端口、资源占用、访问地址）
./server.sh logs           # 查看最近日志
./server.sh logs -f        # 实时跟踪日志
./server.sh port 8080      # 更改端口（运行中自动重启）

# 开机自启（需要 root）
sudo ./server.sh install-service    # 注册 systemd 服务
sudo ./server.sh uninstall-service  # 卸载

# 防火墙（需要 root，依赖 ufw）
sudo ./server.sh firewall open      # 开放当前端口
sudo ./server.sh firewall status    # 查看防火墙状态
```

---

## 界面说明

### 聊天界面

```
┌────────────────────────────────────────────────────┐
│  Claude Code Web   ● 已连接   [A-][A+]  [文件][退出]│ ← 顶栏
├────────────────────────────────────────────────────┤
│                                                    │
│   （xterm.js 终端，显示 Claude 的彩色输出）          │
│                                                    │
├────────────────────────────────────────────────────┤
│  [↑][↓][↵ 确认][Tab][Esc][/clear][⊘ 中断][⏏ 退出]  │ ← 快捷键工具栏
├────────────────────────────────────────────────────┤
│  [ 输入消息…                          ]  [ 发送 ]  │ ← 输入框
└────────────────────────────────────────────────────┘
```

**快捷键：**

| 操作 | 快捷键 |
|------|--------|
| 发送消息 | Enter |
| 换行 | Shift + Enter |
| 复制终端选中内容 | Ctrl + C（有选中文字时） |
| 粘贴到终端 | Ctrl + V |
| 中断 Claude | 工具栏 ⊘ 中断（发送 Ctrl+C） |
| 调整字体大小 | 顶栏 A- / A+ |

### 文件浏览器

点击顶栏 **[文件]** 切换到文件视图。

**文件树**：
- 目录导航，`◀` 按钮折叠文件树，拖动分隔条调整宽度
- `⟳` 刷新按钮，Agent 修改文件后同步最新内容

**文件预览（单击文件）**：

| 类型 | 渲染方式 |
|------|---------|
| `.md` | Markdown 渲染 |
| `.js`、`.py`、`.go` 等 | 代码语法高亮 |
| `.docx` | Word 文档预览 |
| `.xlsx`、`.xls`、`.csv` | 表格预览（sticky 表头） |
| `.pdf` | 内嵌 PDF 阅读器 |
| 其他文本 | 原文显示 |

**在线编辑（文本/代码/Markdown 文件）**：
- 点击 `编辑` 按钮进入编辑模式，文件树自动隐藏以扩大编辑区
- 手动保存或 30s 自动保存，采用增量 patch 节省带宽
- Agent 修改同一文件时显示橙色警告条，可选择"重新加载"或"强制覆盖保存"

**左右双栏**：
- 拖拽文件到内容区**左半边** → 在左栏打开
- 拖拽文件到内容区**右半边** → 自动唤起右栏，在右栏打开
- 拖动中间分隔条调整左右宽度，点击右栏 `✕` 关闭右栏
- 两栏可同时独立编辑不同文件

---

## 安全机制

本项目对多用户场景做了三层目录访问控制：

**第一层 — Web API 路径检查**（`server.js`）

`/api/files` 和 `/api/file` 接口在返回文件内容前，通过 `withinRoot()` 函数验证路径必须在用户 `workDir` 内，否则返回 HTTP 403。

**第二层 — Claude 工具 PreToolUse Hook**（`hooks/check-path.sh`）

Claude Code 每次调用 `Read`、`Write`、`Edit`、`Glob` 等文件工具前，先执行 `check-path.sh`。脚本读取 `ALLOWED_DIR` 环境变量，路径越界时以退出码 2 拒绝工具调用，Claude 将收到拒绝原因。

**第三层 — Bash 命令路径检测**（`hooks/check-path.sh`）

对 `Bash` 工具的命令进行绝对路径提取和检测，捕获明显的越权访问。注意：Bash 工具无法做到完全可靠的限制（变量绑定、`cd` 等方式可绕过），如需彻底隔离建议使用 Docker 容器。

**其他安全措施：**
- 密码使用 bcrypt 加盐哈希存储
- JWT 令牌 24 小时过期，密钥随机生成并持久化在服务器
- 文件读取限制 500 KB 以内
- 30 分钟无操作自动清理空闲 PTY 进程

---

## 生产环境部署

### Nginx 反代 + HTTPS（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        # WebSocket 支持（必须）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

配置 HTTPS 后，将 3000 端口从防火墙关闭，只对外暴露 443：

```bash
sudo ufw allow 443
sudo ufw deny 3000
```

### 开机自启

```bash
sudo ./server.sh install-service
# 之后也可通过 systemctl 管理
sudo systemctl status claude-code-web
sudo journalctl -u claude-code-web -f
```

---

## 常见问题

**Q: 提示"无法启动 Claude 进程"**

确认 `claude` 命令在 PATH 中且已完成认证：
```bash
which claude
claude  # 首次运行需登录认证
```

**Q: node-pty 安装失败**

```bash
apt-get install -y build-essential python3 libssl-dev
npm install --build-from-source
```

**Q: 忘记密码**

```bash
./manage_users.sh passwd <用户名> <新密码>
```

**Q: 刷新页面后终端内容丢失**

服务端保留最近 100 KB 的终端滚动缓冲，重连时自动回放。若服务重启则会话丢失，需重新登录。

**Q: 多标签页能同时使用吗**

同一账号的多个标签页共享同一个 Claude 进程，输入输出互相同步。

---

## 贡献指南

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'Add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源，你可以自由使用、修改和分发本项目代码，但需保留原始版权声明。

---

> **注意**：本项目依赖 [Claude Code](https://claude.ai/code)（Anthropic 提供的 CLI 工具），使用时请遵守 Anthropic 的[服务条款](https://www.anthropic.com/legal/consumer-terms)。
