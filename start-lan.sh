#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

log() {
  printf "\n==> %s\n" "$1"
}

fail() {
  printf "错误：%s\n" "$1" >&2
  exit 1
}

random_token() {
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
}

ensure_node() {
  command -v node >/dev/null 2>&1 || fail "未找到 Node.js。请先安装 Node.js 22.12 或更高版本。"
  command -v npm >/dev/null 2>&1 || fail "未找到 npm。请确认 Node.js 安装完整。"
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)" \
    || fail "当前 Node.js 版本是 $(node -v)，需要 v22.12 或更高版本。"
}

ensure_env() {
  if [[ -f .env.lan ]]; then
    log "使用已有 .env.lan 配置"
    return
  fi

  log "未找到 .env.lan，正在自动生成局域网配置"
  local auth_secret
  local bootstrap_code
  auth_secret="$(random_token)"
  bootstrap_code="$(random_token)"

  cat > .env.lan <<EOF
NODE_ENV=lan
HOST=0.0.0.0
PORT=4000
DB_PATH=./data/app.sqlite
APP_URL=http://localhost:4000
AUTH_SECRET=$auth_secret
BOOTSTRAP_CODE=$bootstrap_code
EOF

  printf "\n首次管理员注册注册码：%s\n" "$bootstrap_code"
  printf "该注册码已保存到 .env.lan 的 BOOTSTRAP_CODE 中。\n"
}

ensure_dependencies() {
  if [[ ! -d node_modules || ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "安装依赖"
    npm ci
    return
  fi

  log "依赖已存在，跳过安装"
}

ensure_build() {
  local needs_build=0
  if [[ ! -f dist/index.html ]]; then
    needs_build=1
  elif find index.html package.json package-lock.json vite.config.js src -type f -newer dist/index.html | grep -q .; then
    needs_build=1
  fi

  if [[ "$needs_build" == "1" ]]; then
    log "构建前端"
    npm run build
    return
  fi

  log "前端构建产物已存在，跳过构建"
}

ensure_node
ensure_env
ensure_dependencies
ensure_build

log "启动局域网服务"
exec npm run lan:start
