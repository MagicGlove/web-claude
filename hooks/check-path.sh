#!/usr/bin/env bash
# PreToolUse hook：限制 Claude 工具只能访问 ALLOWED_DIR 指定的目录。
# server.js 在启动 PTY 时通过环境变量注入 ALLOWED_DIR。
# 未设置 ALLOWED_DIR 时不做任何限制（兼容开发者直接使用 Claude Code 的场景）。

set -uo pipefail

ALLOWED_DIR="${ALLOWED_DIR:-}"
[ -z "$ALLOWED_DIR" ] && exit 0

# 规范化：去尾部斜杠，解析 symlink
ALLOWED_DIR="$(realpath -m "$ALLOWED_DIR" 2>/dev/null || echo "$ALLOWED_DIR")"
ALLOWED_DIR="${ALLOWED_DIR%/}"

INPUT="$(cat)"

# 用 python3 安全解析 JSON 字段（比 grep/sed 更可靠）
get_field() {
  python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    keys = sys.argv[2].split('.')
    v = d
    for k in keys:
        v = v.get(k, '') if isinstance(v, dict) else ''
    print(v if v is not None else '', end='')
except Exception:
    print('', end='')
" "$INPUT" "$1" 2>/dev/null || true
}

TOOL="$(get_field tool_name)"

# 检查单个路径是否在 ALLOWED_DIR 内
check_path() {
  local p="$1"
  [ -z "$p" ] && return 0
  local real
  real="$(realpath -m "$p" 2>/dev/null || echo "$p")"
  real="${real%/}"
  if [[ "$real" != "$ALLOWED_DIR" && "$real" != "$ALLOWED_DIR/"* ]]; then
    echo "访问被拒绝：路径 '$p' 超出工作目录 '$ALLOWED_DIR' 的范围。"
    exit 2
  fi
}

case "$TOOL" in

  # ── 文件工具：直接检查 file_path ──────────────────────────────────────────
  Read|Write|Edit|MultiEdit)
    check_path "$(get_field tool_input.file_path)"
    ;;

  # ── Notebook 工具：字段名为 notebook_path ─────────────────────────────────
  NotebookRead|NotebookEdit)
    check_path "$(get_field tool_input.notebook_path)"
    ;;

  # ── Glob：检查搜索起始目录 ────────────────────────────────────────────────
  Glob)
    p="$(get_field tool_input.path)"
    [ -n "$p" ] && check_path "$p"
    ;;

  # ── Bash：尽力检测命令中的绝对路径 ───────────────────────────────────────
  # 注意：Bash 工具无法完全可靠地限制路径，此处仅捕获明显违规的情况。
  # 如需彻底隔离，应在 server.js 中以 --disallowedTools Bash 启动 Claude。
  Bash)
    CMD="$(get_field tool_input.command)"

    # 提取命令中所有绝对路径（以 / 开头，排除系统公共目录）
    SYSTEM_PREFIXES="/dev/ /proc/ /sys/ /tmp/ /run/ /bin/ /sbin/ /usr/bin/ /usr/sbin/ /usr/local/bin/ /lib/ /lib64/"

    while IFS= read -r abs_path; do
      [ -z "$abs_path" ] && continue

      # 跳过系统公共目录
      is_system=false
      for prefix in $SYSTEM_PREFIXES; do
        if [[ "$abs_path" == "$prefix"* ]]; then
          is_system=true
          break
        fi
      done
      $is_system && continue

      real="$(realpath -m "$abs_path" 2>/dev/null || echo "$abs_path")"
      real="${real%/}"
      if [[ "$real" != "$ALLOWED_DIR" && "$real" != "$ALLOWED_DIR/"* ]]; then
        echo "访问被拒绝：Bash 命令中包含工作目录外的路径 '$abs_path'。"
        exit 2
      fi
    done < <(echo "$CMD" | grep -oE '(/[a-zA-Z0-9_][a-zA-Z0-9_./ -]*)' 2>/dev/null || true)
    ;;
esac

exit 0
