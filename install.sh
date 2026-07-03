#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shiye-management-system}"
APP_DIR="${APP_DIR:-/opt/shiye-management-system}"
PORT="${PORT:-3388}"
ADMIN_PATH="${ADMIN_PATH:-/admin}"
REPO_URL="${REPO_URL:-}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
ENV_FILE="/etc/default/${APP_NAME}"
INTERACTIVE="${INTERACTIVE:-auto}"
INSTALL_NODE="${INSTALL_NODE:-auto}"
INSTALL_NGINX="${INSTALL_NGINX:-}"
SETUP_SSL="${SETUP_SSL:-}"
DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

if [ -z "${DB_CLIENT:-}" ]; then
  if [ -n "${DATABASE_URL:-}" ] || [ -n "${MYSQL_HOST:-}" ]; then
    DB_CLIENT="mysql"
  else
    DB_CLIENT="json"
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 用户运行：sudo bash install.sh"
  exit 1
fi

can_prompt() {
  [ "${INTERACTIVE}" != "0" ] && [ "${INTERACTIVE}" != "false" ] && [ -t 0 ]
}

is_yes() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    y|yes|1|true|是) return 0 ;;
    *) return 1 ;;
  esac
}

ask_value() {
  prompt="$1"
  default_value="${2:-}"
  secret="${3:-0}"
  if ! can_prompt; then
    printf '%s' "${default_value}"
    return
  fi
  if [ -n "${default_value}" ]; then
    label="${prompt} [${default_value}]"
  else
    label="${prompt}"
  fi
  if [ "${secret}" = "1" ]; then
    read -r -s -p "${label}: " value
    echo >&2
  else
    read -r -p "${label}: " value
  fi
  printf '%s' "${value:-${default_value}}"
}

ask_yes_no() {
  prompt="$1"
  default_value="${2:-y}"
  if ! can_prompt; then
    is_yes "${default_value}"
    return
  fi
  if is_yes "${default_value}"; then
    suffix="Y/n"
  else
    suffix="y/N"
  fi
  read -r -p "${prompt} [${suffix}]: " value
  value="${value:-${default_value}}"
  is_yes "${value}"
}

ask_choice() {
  prompt="$1"
  default_value="$2"
  shift 2
  if ! can_prompt; then
    printf '%s' "${default_value}"
    return
  fi
  echo >&2
  echo "${prompt}" >&2
  index=1
  for option in "$@"; do
    echo "  ${index}) ${option}" >&2
    index=$((index + 1))
  done
  read -r -p "请选择 [${default_value}]: " value
  printf '%s' "${value:-${default_value}}"
}

normalize_route_path() {
  value="${1:-/admin}"
  case "${value}" in
    /*) printf '%s' "${value%/}" ;;
    *) printf '/%s' "${value%/}" ;;
  esac
}

package_install() {
  if command -v apt >/dev/null 2>&1; then
    apt update
    apt install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$@"
  else
    echo "未识别的系统包管理器，请手动安装：$*"
    exit 1
  fi
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 12
  elif [ -r /dev/urandom ]; then
    od -An -N12 -tx1 /dev/urandom | tr -d ' \n'
    echo
  else
    date +%s%N | sha256sum | cut -c 1-24
  fi
}

validate_mysql_identifier() {
  label="$1"
  value="$2"
  case "${value}" in
    ''|*[!A-Za-z0-9_]*|[0-9]*)
      echo "${label} 只能使用字母、数字、下划线，并且不能以数字开头：${value}"
      exit 1
      ;;
  esac
}

install_node() {
  if [ "${INSTALL_NODE}" = "0" ] || [ "${INSTALL_NODE}" = "false" ]; then
    echo "==> 跳过 Node.js 安装"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${major}" -ge 20 ]; then
      echo "==> 已检测到 Node.js $(node -v)"
      return
    fi
  fi

  echo "==> 安装 Node.js 20 和 Git"
  if command -v apt >/dev/null 2>&1; then
    apt update
    apt install -y curl ca-certificates gnupg git
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs git curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs git curl ca-certificates
  else
    echo "未识别的系统包管理器，请手动安装 Node.js 20 和 Git。"
    exit 1
  fi
}

start_database_service() {
  systemctl enable --now mariadb >/dev/null 2>&1 || true
  systemctl enable --now mysql >/dev/null 2>&1 || true
}

install_local_mysql() {
  echo "==> 安装本机 MariaDB/MySQL"
  if command -v mysql >/dev/null 2>&1; then
    start_database_service
    return
  fi
  if command -v apt >/dev/null 2>&1; then
    package_install mariadb-server mariadb-client
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    package_install mariadb-server mariadb
  fi
  start_database_service
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

mysql_root_exec() {
  sql_file="$1"
  if mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    mysql -uroot < "${sql_file}"
    return
  fi
  root_password="${MYSQL_ROOT_PASSWORD:-}"
  if [ -z "${root_password}" ] && can_prompt; then
    root_password="$(ask_value '请输入 MySQL root 密码，若无密码请直接回车' '' 1)"
  fi
  if [ -n "${root_password}" ]; then
    mysql -uroot -p"${root_password}" < "${sql_file}"
    return
  fi
  echo "无法使用 root 连接 MySQL，请设置 MYSQL_ROOT_PASSWORD 后重试，或先手动创建数据库。"
  exit 1
}

create_local_mysql_database() {
  MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
  MYSQL_PORT="${MYSQL_PORT:-3306}"
  MYSQL_DATABASE="${MYSQL_DATABASE:-shiye_management}"
  MYSQL_USER="${MYSQL_USER:-shiye}"
  validate_mysql_identifier '数据库名' "${MYSQL_DATABASE}"
  validate_mysql_identifier '数据库用户' "${MYSQL_USER}"
  if [ -z "${MYSQL_PASSWORD:-}" ]; then
    MYSQL_PASSWORD="$(random_password)"
  fi

  tmp_sql="$(mktemp)"
  db_name="$(sql_escape "${MYSQL_DATABASE}")"
  db_user="$(sql_escape "${MYSQL_USER}")"
  db_pass="$(sql_escape "${MYSQL_PASSWORD}")"
  cat > "${tmp_sql}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${db_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${db_user}'@'127.0.0.1' IDENTIFIED BY '${db_pass}';
CREATE USER IF NOT EXISTS '${db_user}'@'localhost' IDENTIFIED BY '${db_pass}';
GRANT ALL PRIVILEGES ON \`${db_name}\`.* TO '${db_user}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${db_name}\`.* TO '${db_user}'@'localhost';
FLUSH PRIVILEGES;
SQL
  mysql_root_exec "${tmp_sql}"
  rm -f "${tmp_sql}"
}

configure_database_interactive() {
  if ! can_prompt; then
    return
  fi
  if [ -n "${DATABASE_URL:-}" ] || [ -n "${MYSQL_HOST:-}" ]; then
    return
  fi

  choice="$(ask_choice '请选择数据存储方式' 1 '自动安装本机 MySQL/MariaDB（公开运营推荐）' '连接已有 MySQL 数据库' 'JSON 文件模式（仅测试/个人使用）')"
  case "${choice}" in
    1)
      DB_CLIENT="mysql"
      MYSQL_HOST="$(ask_value '数据库地址' '127.0.0.1')"
      MYSQL_PORT="$(ask_value '数据库端口' '3306')"
      MYSQL_DATABASE="$(ask_value '数据库名' 'shiye_management')"
      MYSQL_USER="$(ask_value '数据库用户' 'shiye')"
      MYSQL_PASSWORD="$(ask_value '数据库密码，留空会自动生成' '' 1)"
      install_local_mysql
      create_local_mysql_database
      ;;
    2)
      DB_CLIENT="mysql"
      MYSQL_HOST="$(ask_value '数据库地址' '127.0.0.1')"
      MYSQL_PORT="$(ask_value '数据库端口' '3306')"
      MYSQL_DATABASE="$(ask_value '数据库名' 'shiye_management')"
      MYSQL_USER="$(ask_value '数据库用户' 'shiye')"
      MYSQL_PASSWORD="$(ask_value '数据库密码' '' 1)"
      ;;
    3)
      DB_CLIENT="json"
      ;;
    *)
      echo "无效选择。"
      exit 1
      ;;
  esac
}

test_mysql_connection() {
  if [ "${DB_CLIENT}" != "mysql" ] && [ "${DB_CLIENT}" != "mariadb" ]; then
    return
  fi
  echo "==> 测试 MySQL 连接"
  node - <<'NODE'
const mysql = require('mysql2/promise');
(async () => {
  const pool = await mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'shiye',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'shiye_management',
    waitForConnections: true,
    connectionLimit: 1,
    charset: 'utf8mb4'
  });
  await pool.query('SELECT 1');
  await pool.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

configure_nginx_interactive() {
  if ! can_prompt; then
    INSTALL_NGINX="${INSTALL_NGINX:-0}"
    SETUP_SSL="${SETUP_SSL:-0}"
    return
  fi
  if [ -z "${INSTALL_NGINX}" ]; then
    if ask_yes_no '是否安装/配置 Nginx 反向代理' 'n'; then
      INSTALL_NGINX="1"
    else
      INSTALL_NGINX="0"
    fi
  fi
  if is_yes "${INSTALL_NGINX}"; then
    DOMAIN="$(ask_value '绑定域名，留空则使用服务器 IP 访问' "${DOMAIN}")"
    if [ -n "${DOMAIN}" ] && [ -z "${SETUP_SSL}" ]; then
      if ask_yes_no '是否自动申请 HTTPS 证书' 'n'; then
        SETUP_SSL="1"
        CERTBOT_EMAIL="$(ask_value '证书邮箱，留空则不填写邮箱' "${CERTBOT_EMAIL}")"
      else
        SETUP_SSL="0"
      fi
    fi
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
      echo "curl -fsSL https://raw.githubusercontent.com/你的用户名/你的仓库/main/install.sh -o install.sh"
      echo "REPO_URL=https://github.com/你的用户名/你的仓库.git bash install.sh"
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

install_nginx() {
  if ! is_yes "${INSTALL_NGINX:-0}"; then
    return
  fi
  echo "==> 安装/配置 Nginx"
  if ! command -v nginx >/dev/null 2>&1; then
    package_install nginx
  fi
  systemctl enable --now nginx >/dev/null 2>&1 || true
  server_name="_"
  if [ -n "${DOMAIN}" ]; then
    server_name="${DOMAIN}"
  fi
  cat > "/etc/nginx/conf.d/${APP_NAME}.conf" <<NGINX
server {
    listen 80;
    server_name ${server_name};

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
  nginx -t
  systemctl reload nginx
}

install_certbot() {
  if ! is_yes "${SETUP_SSL:-0}"; then
    return
  fi
  if [ -z "${DOMAIN}" ]; then
    echo "未填写域名，跳过证书申请。"
    return
  fi
  echo "==> 安装 Certbot 并申请 HTTPS 证书"
  if command -v apt >/dev/null 2>&1; then
    package_install certbot python3-certbot-nginx
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    package_install certbot python3-certbot-nginx
  fi
  if [ -n "${CERTBOT_EMAIL}" ]; then
    certbot --nginx -d "${DOMAIN}" --redirect --agree-tos -m "${CERTBOT_EMAIL}" --non-interactive
  else
    certbot --nginx -d "${DOMAIN}" --redirect --agree-tos --register-unsafely-without-email --non-interactive
  fi
}

print_summary() {
  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  nginx_conf="/etc/nginx/conf.d/${APP_NAME}.conf"
  if is_yes "${INSTALL_NGINX:-0}" && [ -n "${DOMAIN}" ]; then
    scheme="http"
    if is_yes "${SETUP_SSL:-0}"; then
      scheme="https"
    fi
    user_url="${scheme}://${DOMAIN}/"
    admin_url="${scheme}://${DOMAIN}${ADMIN_PATH}"
  else
    user_url="http://${ip_addr:-服务器IP}:${PORT}/"
    admin_url="http://${ip_addr:-服务器IP}:${PORT}${ADMIN_PATH}"
  fi
  echo
  echo "============================================================"
  echo "十夜管理系统安装完成，请复制保存以下信息"
  echo "============================================================"
  echo "用户入口：${user_url}"
  echo "管理员入口：${admin_url}"
  echo "默认管理员账号：admin"
  echo "默认管理员密码：admin123"
  echo ""
  echo "项目信息："
  echo "项目目录：${APP_DIR}"
  echo "运行端口：${PORT}"
  echo "管理员路径：${ADMIN_PATH}"
  echo "服务名称：${APP_NAME}"
  echo "服务配置：${SERVICE_FILE}"
  echo "环境配置：${ENV_FILE}"
  echo "数据存储：${DB_CLIENT}"
  if [ "${DB_CLIENT}" = "mysql" ] || [ "${DB_CLIENT}" = "mariadb" ]; then
    echo ""
    echo "MySQL 连接信息："
    echo "数据库地址：${MYSQL_HOST:-127.0.0.1}"
    echo "数据库端口：${MYSQL_PORT:-3306}"
    echo "数据库名称：${MYSQL_DATABASE:-shiye_management}"
    echo "数据库账号：${MYSQL_USER:-shiye}"
    echo "数据库密码：${MYSQL_PASSWORD:-}"
  fi
  if is_yes "${INSTALL_NGINX:-0}"; then
    echo ""
    echo "Nginx 信息："
    echo "Nginx 配置：${nginx_conf}"
    echo "绑定域名：${DOMAIN:-未绑定域名，使用服务器 IP}"
    if is_yes "${SETUP_SSL:-0}" && [ -n "${DOMAIN}" ]; then
      echo "HTTPS 证书：已申请"
    else
      echo "HTTPS 证书：未申请"
    fi
  fi
  echo
  echo "常用命令："
  echo "systemctl status ${APP_NAME}"
  echo "systemctl restart ${APP_NAME}"
  echo "journalctl -u ${APP_NAME} -f"
  echo ""
  echo "说明：本系统基于 3-xui 面板 3.4.1 版本开发和测试。"
  echo "公网部署建议登录后立即进入账号安全修改管理员密码。"
  echo "============================================================"
}

main() {
  echo "==> 十夜管理系统安装向导"
  if can_prompt; then
    PORT="$(ask_value '项目运行端口' "${PORT}")"
    ADMIN_PATH="$(normalize_route_path "$(ask_value '管理员入口路径' "${ADMIN_PATH}")")"
    APP_DIR="$(ask_value '安装目录' "${APP_DIR}")"
    if [ -z "${REPO_URL}" ]; then
      REPO_URL="$(ask_value 'GitHub 仓库地址，本地安装可留空' 'https://github.com/wstimin/3-xuiguanli-shangye.git')"
    fi
  fi

  configure_database_interactive
  configure_nginx_interactive

  install_node

  echo "==> 安装项目文件到 ${APP_DIR}"
  install_app_files

  echo "==> 安装项目依赖"
  install_dependencies

  export MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
  export MYSQL_PORT="${MYSQL_PORT:-3306}"
  export MYSQL_USER="${MYSQL_USER:-shiye}"
  export MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
  export MYSQL_DATABASE="${MYSQL_DATABASE:-shiye_management}"
  test_mysql_connection

  echo "==> 检查语法"
  cd "${APP_DIR}"
  node --check server.js
  node --check public/app.js

  echo "==> 写入 systemd 服务"
  write_service
  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"

  install_nginx
  install_certbot

  echo "==> 服务状态"
  systemctl --no-pager --full status "${APP_NAME}" || true
  print_summary
}

main "$@"
