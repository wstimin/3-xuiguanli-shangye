#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shiye-management-system}"
APP_DIR="${APP_DIR:-/opt/shiye-management-system}"
PORT="${PORT:-3388}"
ADMIN_PATH="${ADMIN_PATH:-/admin}"
if [ -z "${DB_CLIENT:-}" ]; then
  if [ -n "${DATABASE_URL:-}" ] || [ -n "${MYSQL_HOST:-}" ]; then
    DB_CLIENT="mysql"
  else
    DB_CLIENT="json"
  fi
fi
REPO_URL="${REPO_URL:-}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
ENV_FILE="/etc/default/${APP_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 用户运行：sudo bash install.sh"
  exit 1
fi

install_node() {
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${major}" -ge 20 ]; then
      return
    fi
  fi

  if command -v apt >/dev/null 2>&1; then
    apt update
    apt install -y curl ca-certificates gnupg git
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs git
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs git
  else
    echo "未识别的系统包管理器，请手动安装 Node.js 20 和 Git。"
    exit 1
  fi
}

install_app_files() {
  mkdir -p "${APP_DIR}"
  preserve_dir="$(mktemp -d)"
  if [ -d "${APP_DIR}/data" ]; then
    cp -a "${APP_DIR}/data" "${preserve_dir}/data"
  fi

  if [ -n "${REPO_URL}" ]; then
    if [ -d "${APP_DIR}/.git" ]; then
      git -C "${APP_DIR}" pull --ff-only
    else
      tmp_dir="$(mktemp -d)"
      git clone "${REPO_URL}" "${tmp_dir}/app"
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      cp -a "${tmp_dir}/app/." "${APP_DIR}/"
      rm -rf "${tmp_dir}"
    fi
  else
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ ! -f "${script_dir}/server.js" ]; then
      echo "远程安装请设置 REPO_URL，例如："
      echo "REPO_URL=https://github.com/你的用户名/你的仓库.git bash <(curl -fsSL https://raw.githubusercontent.com/你的用户名/你的仓库/main/install.sh)"
      exit 1
    fi
    if [ "${script_dir}" != "${APP_DIR}" ]; then
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      find "${script_dir}" -mindepth 1 -maxdepth 1 -exec cp -a {} "${APP_DIR}/" \;
    fi
  fi
  if [ -d "${preserve_dir}/data" ]; then
    rm -rf "${APP_DIR}/data"
    cp -a "${preserve_dir}/data" "${APP_DIR}/data"
  fi
  rm -rf "${preserve_dir}"
  mkdir -p "${APP_DIR}/data"
}

install_dependencies() {
  cd "${APP_DIR}"
  npm install --omit=dev
}

write_service() {
  existing_secret=""
  if [ -n "${APP_SECRET:-}" ]; then
    existing_secret="${APP_SECRET}"
  elif [ -n "${SHIYE_SECRET:-}" ]; then
    existing_secret="${SHIYE_SECRET}"
  elif [ -f "${ENV_FILE}" ]; then
    existing_secret="$(grep -E '^APP_SECRET=' "${ENV_FILE}" | tail -n 1 | sed 's/^APP_SECRET=//' | sed 's/^"//' | sed 's/"$//' || true)"
  elif [ -f "${APP_DIR}/data/.secret" ]; then
    existing_secret="$(tr -d '\r\n' < "${APP_DIR}/data/.secret")"
  fi
  if [ -z "${existing_secret}" ]; then
    if command -v openssl >/dev/null 2>&1; then
      existing_secret="$(openssl rand -hex 32)"
    else
      existing_secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    fi
  fi

  write_env_var() {
    key="$1"
    value="$2"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s="%s"\n' "${key}" "${value}"
  }

  {
    write_env_var PORT "${PORT}"
    write_env_var ADMIN_PATH "${ADMIN_PATH}"
    write_env_var DB_CLIENT "${DB_CLIENT}"
    write_env_var APP_SECRET "${existing_secret}"
    write_env_var DATABASE_URL "${DATABASE_URL:-}"
    write_env_var MYSQL_HOST "${MYSQL_HOST:-127.0.0.1}"
    write_env_var MYSQL_PORT "${MYSQL_PORT:-3306}"
    write_env_var MYSQL_USER "${MYSQL_USER:-shiye}"
    write_env_var MYSQL_PASSWORD "${MYSQL_PASSWORD:-}"
    write_env_var MYSQL_DATABASE "${MYSQL_DATABASE:-shiye_management}"
    write_env_var MYSQL_CONNECTION_LIMIT "${MYSQL_CONNECTION_LIMIT:-10}"
    write_env_var REDIS_URL "${REDIS_URL:-}"
    write_env_var SESSION_PREFIX "${SESSION_PREFIX:-shiye:session:}"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Shiye Management System
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE
}

main() {
  echo "==> 安装 Node.js 20"
  install_node

  echo "==> 安装项目文件到 ${APP_DIR}"
  install_app_files

  echo "==> 安装项目依赖"
  install_dependencies

  echo "==> 检查语法"
  cd "${APP_DIR}"
  node --check server.js
  node --check public/app.js

  echo "==> 写入 systemd 服务"
  write_service
  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"

  echo "==> 服务状态"
  systemctl --no-pager --full status "${APP_NAME}" || true

  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "安装完成。"
  echo "用户入口：http://${ip_addr:-服务器IP}:${PORT}/"
  echo "管理员入口：http://${ip_addr:-服务器IP}:${PORT}${ADMIN_PATH}"
  echo "数据存储：${DB_CLIENT}"
  echo "说明：本系统基于 3-xui 面板 3.4.1 版本开发和测试。"
  echo "默认管理员账号：admin"
  echo "默认管理员密码：admin123"
  echo
  echo "常用命令："
  echo "systemctl status ${APP_NAME}"
  echo "systemctl restart ${APP_NAME}"
  echo "journalctl -u ${APP_NAME} -f"
}

main "$@"
