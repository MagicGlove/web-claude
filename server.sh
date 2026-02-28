#!/usr/bin/env bash
# server.sh — Claude Code Web 服务器管理脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_JS="$SCRIPT_DIR/server.js"
PID_FILE="$SCRIPT_DIR/.server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
CONF_FILE="$SCRIPT_DIR/.server.conf"
SERVICE_NAME="claude-code-web"

# ── 读取/写入配置 ──────────────────────────────────────────────────────────────

conf_get() {
  local key="$1" default="${2:-}"
  if [ -f "$CONF_FILE" ]; then
    local val
    val="$(grep "^${key}=" "$CONF_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')"
    echo "${val:-$default}"
  else
    echo "$default"
  fi
}

conf_set() {
  local key="$1" val="$2"
  if [ -f "$CONF_FILE" ] && grep -q "^${key}=" "$CONF_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$CONF_FILE"
  else
    echo "${key}=${val}" >> "$CONF_FILE"
  fi
}

PORT="$(conf_get PORT 3000)"

# ── 颜色 ──────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }

# ── 工具函数 ──────────────────────────────────────────────────────────────────

require_root() {
  if [ "$EUID" -ne 0 ]; then
    err "此操作需要 root 权限，请使用 sudo ./server.sh $*"
    exit 1
  fi
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill -0 "$pid" 2>/dev/null
  else
    return 1
  fi
}

get_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" || echo ""
}

get_local_ips() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -5
}

check_node() {
  if ! command -v node &>/dev/null; then
    err "未找到 node，请先安装 Node.js 18+"
    exit 1
  fi
}

check_deps() {
  if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    warn "依赖未安装，正在执行 npm install..."
    cd "$SCRIPT_DIR" && npm install --silent
    ok "依赖安装完成"
  fi
}

port_in_use() {
  local p="$1"
  ss -tlnp 2>/dev/null | grep -q ":${p} " || \
  lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | grep -qv "^$"
}

# ── 命令：start ───────────────────────────────────────────────────────────────

cmd_start() {
  local port="${1:-$PORT}"
  check_node
  check_deps

  if is_running; then
    warn "服务已在运行中（PID $(get_pid)，端口 $PORT）"
    return
  fi

  # 检查端口占用
  if port_in_use "$port"; then
    err "端口 $port 已被占用，请先释放或换一个端口"
    info "查看占用：lsof -i:$port"
    info "换端口：./server.sh port <新端口号>"
    exit 1
  fi

  info "启动服务（端口 $port）..."
  cd "$SCRIPT_DIR"
  PORT="$port" nohup node "$APP_JS" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  conf_set PORT "$port"

  # 等待确认启动
  sleep 1
  if is_running; then
    ok "服务已启动（PID $pid）"
    echo ""
    print_urls "$port"
  else
    err "启动失败，查看日志：./server.sh logs"
    rm -f "$PID_FILE"
    exit 1
  fi
}

# ── 命令：stop ────────────────────────────────────────────────────────────────

cmd_stop() {
  if ! is_running; then
    warn "服务未在运行"
    return
  fi

  local pid
  pid="$(get_pid)"
  info "停止服务（PID $pid）..."
  kill "$pid" 2>/dev/null || true

  # 等待进程退出
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
    sleep 0.5; i=$((i+1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "进程未响应，强制终止..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  ok "服务已停止"
}

# ── 命令：restart ─────────────────────────────────────────────────────────────

cmd_restart() {
  local port="${1:-$PORT}"
  info "重启服务..."
  cmd_stop
  sleep 0.5
  cmd_start "$port"
}

# ── 命令：status ──────────────────────────────────────────────────────────────

cmd_status() {
  echo ""
  echo -e "${BOLD}═══ Claude Code Web 服务状态 ═══${RESET}"
  echo ""

  if is_running; then
    local pid
    pid="$(get_pid)"
    echo -e "  状态      ${GREEN}● 运行中${RESET}"
    echo -e "  PID       $pid"
    echo -e "  端口      $PORT"

    # 内存/CPU 占用
    if command -v ps &>/dev/null; then
      local stats
      stats="$(ps -o pid=,pcpu=,pmem=,etime= -p "$pid" 2>/dev/null | awk '{printf "CPU %.1f%%  MEM %.1f%%  运行时间 %s", $2, $3, $4}')"
      echo -e "  资源      $stats"
    fi

    # 活跃连接数
    if command -v ss &>/dev/null; then
      local conns
      conns="$(ss -tn 2>/dev/null | grep ":${PORT}" | grep ESTAB | wc -l)"
      echo -e "  活跃连接  $conns 个"
    fi

    echo ""
    print_urls "$PORT"
  else
    echo -e "  状态      ${RED}● 未运行${RESET}"
    echo ""
    info "启动：./server.sh start"
  fi

  echo ""

  # 防火墙状态
  if command -v ufw &>/dev/null; then
    local ufw_status
    ufw_status="$(ufw status 2>/dev/null | head -1 | awk '{print $2}')"
    if [ "$ufw_status" = "active" ]; then
      local port_rule
      port_rule="$(ufw status 2>/dev/null | grep "^${PORT}" | head -1)"
      if [ -n "$port_rule" ]; then
        echo -e "  防火墙    ${GREEN}端口 $PORT 已开放${RESET}"
      else
        echo -e "  防火墙    ${YELLOW}端口 $PORT 未在防火墙白名单中${RESET}"
        echo -e "            执行 sudo ./server.sh firewall open $PORT 以开放"
      fi
    else
      echo -e "  防火墙    未启用"
    fi
  fi

  # systemd 服务状态
  if systemctl is-enabled "$SERVICE_NAME" &>/dev/null 2>&1; then
    echo -e "  开机自启  ${GREEN}已启用${RESET}（systemd）"
  fi

  echo ""
}

# ── 命令：logs ────────────────────────────────────────────────────────────────

cmd_logs() {
  local follow=false lines=80
  for arg in "$@"; do
    case "$arg" in
      -f|--follow) follow=true ;;
      -n)          shift; lines="${1:-80}" ;;
      [0-9]*)      lines="$arg" ;;
    esac
  done

  if [ ! -f "$LOG_FILE" ]; then
    warn "日志文件不存在（服务从未启动过）"
    return
  fi

  if $follow; then
    info "实时日志（Ctrl+C 退出）："
    tail -n "$lines" -f "$LOG_FILE"
  else
    info "最近 $lines 行日志："
    tail -n "$lines" "$LOG_FILE"
  fi
}

cmd_logs_clear() {
  > "$LOG_FILE"
  ok "日志已清空"
}

# ── 命令：port ────────────────────────────────────────────────────────────────

cmd_port() {
  local new_port="${1:-}"

  if [ -z "$new_port" ]; then
    echo -e "当前端口：${BOLD}$PORT${RESET}"
    info "修改端口：./server.sh port <端口号>"
    return
  fi

  # 验证端口合法性
  if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [ "$new_port" -lt 1 ] || [ "$new_port" -gt 65535 ]; then
    err "无效端口号（范围 1-65535）"
    exit 1
  fi

  if [ "$new_port" -lt 1024 ]; then
    warn "端口 $new_port 小于 1024，启动时可能需要 root 权限"
  fi

  local old_port="$PORT"
  conf_set PORT "$new_port"
  PORT="$new_port"
  ok "端口已更新：$old_port → $new_port"

  if is_running; then
    echo ""
    read -r -p "服务正在运行，是否立即重启以生效？[Y/n] " answer
    answer="${answer:-Y}"
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      cmd_restart "$new_port"
    else
      warn "请手动重启：./server.sh restart"
    fi
  else
    info "下次启动将使用端口 $new_port"
  fi
}

# ── 命令：firewall ────────────────────────────────────────────────────────────

cmd_firewall() {
  local action="${1:-status}"

  if ! command -v ufw &>/dev/null; then
    err "未找到 ufw，请先安装：apt-get install ufw"
    exit 1
  fi

  case "$action" in
    open)
      require_root firewall open "${2:-}"
      local p="${2:-$PORT}"
      info "开放端口 $p/tcp..."
      ufw allow "$p/tcp" comment "claude-code-web"
      ok "端口 $p 已开放"
      ;;

    close)
      require_root firewall close "${2:-}"
      local p="${2:-$PORT}"
      warn "关闭端口 $p/tcp..."
      ufw delete allow "$p/tcp" 2>/dev/null || true
      ok "端口 $p 已关闭"
      ;;

    enable)
      require_root firewall enable
      warn "启用防火墙（确保已开放 SSH 端口 22，否则将失去连接！）"
      read -r -p "确认启用防火墙？[y/N] " answer
      [[ "$answer" =~ ^[Yy]$ ]] || { echo "已取消"; return; }
      ufw allow 22/tcp comment "SSH"
      ufw --force enable
      ok "防火墙已启用"
      ;;

    disable)
      require_root firewall disable
      ufw disable
      ok "防火墙已禁用"
      ;;

    status|*)
      echo ""
      echo -e "${BOLD}═══ 防火墙状态 ═══${RESET}"
      ufw status verbose 2>/dev/null || echo "ufw 未安装"
      echo ""
      ;;
  esac
}

# ── 命令：install / uninstall（systemd 开机自启）────────────────────────────

cmd_install_service() {
  require_root install-service
  check_node

  local node_bin
  node_bin="$(which node)"
  local current_user="${SUDO_USER:-$(whoami)}"

  info "创建 systemd 服务..."
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Claude Code Web Interface
After=network.target

[Service]
Type=simple
User=${current_user}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${node_bin} ${APP_JS}
EnvironmentFile=-${CONF_FILE}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
EOF

  # 将 PORT 写入 EnvironmentFile（systemd 格式）
  if [ ! -f "$CONF_FILE" ] || ! grep -q "^PORT=" "$CONF_FILE"; then
    echo "PORT=$PORT" >> "$CONF_FILE"
  fi

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"

  ok "systemd 服务已安装并设置开机自启"
  info "启动服务：sudo systemctl start $SERVICE_NAME"
  info "查看状态：sudo systemctl status $SERVICE_NAME"
  info "查看日志：sudo journalctl -u $SERVICE_NAME -f"
}

cmd_uninstall_service() {
  require_root uninstall-service
  if systemctl is-active "$SERVICE_NAME" &>/dev/null 2>&1; then
    systemctl stop "$SERVICE_NAME"
  fi
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  ok "systemd 服务已卸载"
}

# ── 命令：url ─────────────────────────────────────────────────────────────────

print_urls() {
  local p="${1:-$PORT}"
  echo -e "${BOLD}访问地址：${RESET}"
  echo -e "  本机      ${CYAN}http://localhost:${p}${RESET}"
  while IFS= read -r ip; do
    [ -n "$ip" ] && echo -e "  局域网    ${CYAN}http://${ip}:${p}${RESET}"
  done < <(get_local_ips)
}

# ── 帮助 ──────────────────────────────────────────────────────────────────────

cmd_help() {
  cat <<HELP

${BOLD}Claude Code Web — 服务器管理脚本${RESET}

${BOLD}用法：${RESET}
  ./server.sh <命令> [参数]

${BOLD}服务管理：${RESET}
  start   [端口]     启动服务（默认端口 $PORT）
  stop               停止服务
  restart [端口]     重启服务
  status             查看运行状态
  url                显示访问地址

${BOLD}日志：${RESET}
  logs               查看最近 80 行日志
  logs -f            实时跟踪日志（Ctrl+C 退出）
  logs <行数>        查看指定行数日志
  logs clear         清空日志文件

${BOLD}端口配置：${RESET}
  port               查看当前端口
  port <端口号>      更改端口（自动重启）

${BOLD}防火墙（需要 sudo）：${RESET}
  firewall status              查看防火墙状态
  firewall open   [端口]       开放端口（默认当前端口）
  firewall close  [端口]       关闭端口
  firewall enable              启用防火墙
  firewall disable             禁用防火墙

${BOLD}开机自启（需要 sudo）：${RESET}
  install-service    安装 systemd 服务（开机自启）
  uninstall-service  卸载 systemd 服务

${BOLD}用户管理：${RESET}
  使用 ./manage_users.sh 进行用户管理

${BOLD}示例：${RESET}
  ./server.sh start                  # 启动（端口 $PORT）
  ./server.sh start 8080             # 启动（端口 8080）
  ./server.sh port 8080              # 改端口并重启
  ./server.sh logs -f                # 实时日志
  sudo ./server.sh firewall open     # 开放当前端口
  sudo ./server.sh install-service   # 设置开机自启

HELP
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

CMD="${1:-help}"
shift || true

case "$CMD" in
  start)            cmd_start "$@" ;;
  stop)             cmd_stop ;;
  restart)          cmd_restart "$@" ;;
  status)           cmd_status ;;
  url|urls)         print_urls "$PORT" ;;
  logs)
    if [ "${1:-}" = "clear" ]; then cmd_logs_clear
    else cmd_logs "$@"
    fi ;;
  port)             cmd_port "$@" ;;
  firewall)         cmd_firewall "$@" ;;
  install-service)  cmd_install_service ;;
  uninstall-service) cmd_uninstall_service ;;
  help|--help|-h)   cmd_help ;;
  *)
    err "未知命令：$CMD"
    echo "运行 ./server.sh help 查看帮助"
    exit 1
    ;;
esac
