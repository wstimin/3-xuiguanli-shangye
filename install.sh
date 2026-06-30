#!/usr/bin/env bash
set -euo pipefail

APP_NAME="shiye-management-system"
APP_DIR="${APP_DIR:-/opt/shiye-management-system}"
PORT="${PORT:-3388}"
REPO_URL="${REPO_URL:-}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

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
  if [ -n "${REPO_URL}" ]; then
    if [ -d "${APP_DIR}/.git" ]; then
      git -C "${APP_DIR}" pull --ff-only
    else
      tmp_dir="$(mktemp -d)"
      git clone "${REPO_URL}" "${tmp_dir}/app"
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
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
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
      find "${script_dir}" -mindepth 1 -maxdepth 1 ! -name data -exec cp -a {} "${APP_DIR}/" \;
    fi
  fi
  mkdir -p "${APP_DIR}/data"
}

write_service() {
  cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Shiye Management System
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
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

  echo "==> 检查语法"
  cd "${APP_DIR}"
  node --check server.js
  node --check public/app.js

  echo "==> 写入 systemd 服务"
  write_service
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}"

  echo "==> 服务状态"
  systemctl --no-pager --full status "${APP_NAME}" || true

  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "安装完成。"
  echo "访问地址：http://${ip_addr:-服务器IP}:${PORT}"
  echo "默认账号：admin"
  echo "默认密码：admin123"
  echo "建议登录后进入账号安全修改密码。"
  echo
  echo "常用命令："
  echo "systemctl status ${APP_NAME}"
  echo "systemctl restart ${APP_NAME}"
  echo "journalctl -u ${APP_NAME} -f"
}

main "$@"
