#!/usr/bin/env bash
# manage_users.sh — Claude Code Web 用户管理工具
# 只能在服务器终端上运行，Web 界面无法访问此脚本

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/admin_helper.js"

if ! command -v node &>/dev/null; then
  echo "错误：未找到 node，请先安装 Node.js 18+"
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/node_modules/.bin/bcryptjs" ] && [ ! -d "$SCRIPT_DIR/node_modules/bcryptjs" ]; then
  echo "提示：依赖未安装，正在执行 npm install..."
  cd "$SCRIPT_DIR" && npm install --silent
fi

if [ $# -lt 1 ]; then
  cat <<'HELP'
Claude Code Web — 用户管理工具

用法：
  ./manage_users.sh add     <用户名> <密码> [工作目录]   添加新用户
  ./manage_users.sh remove  <用户名>                    删除用户
  ./manage_users.sh passwd  <用户名> <新密码>            修改密码
  ./manage_users.sh workdir <用户名> <工作目录>          设置工作目录
  ./manage_users.sh list                                查看所有用户

示例：
  ./manage_users.sh add alice mypassword /usr/code/SkillFrame
  ./manage_users.sh list
  ./manage_users.sh passwd alice newpassword
HELP
  exit 0
fi

node "$HELPER" "$@"
