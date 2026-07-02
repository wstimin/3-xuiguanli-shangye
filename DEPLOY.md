# 十夜管理系统部署教程

本教程适合把十夜管理系统部署到 Linux 服务器。系统可以直接使用 HTTP 访问，不强制配置 Nginx 或 HTTPS；如果你会配置反向代理，也可以后续再加。

本系统基于 3-xui 面板 3.4.1 版本开发和测试。其他 3-xui 版本通常也可以接入，但不同版本或魔改版可能存在 API 差异，建议部署后先在“3x-ui 节点”里点击测试，确认入站列表、用户同步、SOCKS 出站和路由规则写入都正常。

## 1. 推荐部署方式

个人测试可以使用 JSON 文件模式：

```bash
REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

公开给用户使用建议使用 MySQL。先创建数据库和账号：

```sql
CREATE DATABASE shiye_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'shiye'@'127.0.0.1' IDENTIFIED BY '请换成强密码';
GRANT ALL PRIVILEGES ON shiye_management.* TO 'shiye'@'127.0.0.1';
FLUSH PRIVILEGES;
```

然后执行一键安装：

```bash
DB_CLIENT=mysql \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=shiye \
MYSQL_PASSWORD='请换成强密码' \
MYSQL_DATABASE=shiye_management \
ADMIN_PATH=/admin \
REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

如果你 Fork 了本项目，把命令里的仓库地址改成自己的；如果默认分支不是 `main`，也要把链接里的 `main` 改成实际分支名。

当前这些 MySQL 和管理员路径改动只有推送到 GitHub 后，远程一键命令才会拉到最新版本。

MySQL 模式会自动创建分表保存用户、3-xui 节点、SOCKS 节点、卡密、卡密批次、余额流水、续费记录、同步日志和系统设置。旧版 MySQL 一行 JSON 数据或 `data/db.json` 会在首次启动时自动迁移到分表。

这次新增的实用运营功能包括：

- 用户端卡密充值、余额续费、查看自己的余额流水和续费记录
- 管理员端手动调余额，支持增加、扣减、设置固定余额
- 管理员端财务流水，统一查看充值、扣款、调余额和续费记录
- 卡密批次管理，支持同一批次继续生成、一键复制、重命名和删除未使用卡密

## 2. 访问入口

安装完成后访问：

```text
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
```

默认管理员账号：

```text
账号：admin
密码：admin123
```

系统不会强制修改默认密码，但公网部署建议进入右上角“账号安全”修改管理员账号和密码。

普通用户不能注册，只能使用管理员在“用户管理”里创建的登录账号和密码，从用户入口 `/` 登录。管理员账号只能从管理员入口登录。

## 3. 自定义管理员路径

默认管理员入口是 `/admin`。可以安装时改成自己的路径：

```bash
ADMIN_PATH=/myadmin2026 REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

修改后访问：

```text
http://服务器IP:3388/myadmin2026
```

这个路径不是代替密码的安全措施，只是减少后台入口暴露；真正权限仍然由管理员登录校验控制。

## 4. 一键脚本做了什么

`install.sh` 会自动完成：

- 检查或安装 Node.js 20
- 安装 Git
- 把项目放到 `/opt/shiye-management-system`
- 创建或保留 `data/` 数据目录
- 安装项目依赖
- 检查 `server.js` 和 `public/app.js` 语法
- 写入 `/etc/default/shiye-management-system` 配置文件
- 创建 systemd 服务并设置开机自启
- 重启服务

重新执行一键安装可以覆盖程序文件并重启服务。脚本会保留 `data/` 目录，避免覆盖 JSON 数据和本地加密密钥。

## 5. 自定义端口、目录、服务名

自定义端口：

```bash
PORT=8080 REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

自定义安装目录：

```bash
APP_DIR=/opt/my-shiye-panel REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

自定义服务名：

```bash
APP_NAME=x-uiguanli REPO_URL=https://github.com/wstimin/3-xuiguanli-shangye.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

## 6. 常用运行命令

查看服务状态：

```bash
systemctl status shiye-management-system
```

重启服务：

```bash
systemctl restart shiye-management-system
```

停止服务：

```bash
systemctl stop shiye-management-system
```

启动服务：

```bash
systemctl start shiye-management-system
```

查看实时日志：

```bash
journalctl -u shiye-management-system -f
```

查看最近日志：

```bash
journalctl -u shiye-management-system -n 100 --no-pager
```

检查端口是否监听：

```bash
ss -lntp | grep 3388
```

本机测试访问：

```bash
curl -i http://127.0.0.1:3388/
curl -i http://127.0.0.1:3388/admin
```

查看服务环境配置：

```bash
cat /etc/default/shiye-management-system
```

修改配置后重启：

```bash
nano /etc/default/shiye-management-system
systemctl restart shiye-management-system
```

## 7. 手动安装方式

如果不使用一键脚本，可以手动安装。

安装 Node.js 20：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
node -v
```

下载项目：

```bash
cd /opt
git clone https://github.com/wstimin/3-xuiguanli-shangye.git shiye-management-system
cd /opt/shiye-management-system
npm install --omit=dev
```

语法检查：

```bash
node --check server.js
node --check public/app.js
```

临时启动 JSON 模式：

```bash
PORT=3388 ADMIN_PATH=/admin DB_CLIENT=json node server.js
```

临时启动 MySQL 模式：

```bash
PORT=3388 \
ADMIN_PATH=/admin \
DB_CLIENT=mysql \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=shiye \
MYSQL_PASSWORD='请换成强密码' \
MYSQL_DATABASE=shiye_management \
node server.js
```

## 8. 1Panel / 宝塔网页向导安装

1Panel、宝塔等面板部署时，可以不在面板里手动添加数据库环境变量。把项目完整上传到 Node.js 项目目录并启动应用后，首次访问域名会显示“首次安装”页面。

安装向导需要填写：

```text
数据库地址：面板数据库显示的连接地址，常见为 127.0.0.1 或数据库容器名
端口：3306
数据库名称：例如 shiye_management
数据库账号：例如 shiye
数据库密码：创建数据库时设置的密码
```

点击“连接并安装”后，系统会测试 MySQL、自动建表，并把配置保存到：

```text
data/config.json
```

这个文件包含数据库连接信息，备份和迁移时需要保留，不要公开给别人。安装完成后使用管理员入口登录，默认账号为：

```text
账号：admin
密码：admin123
```

如果安装向导提示连接失败，优先检查数据库地址。Node.js 容器里填写 `127.0.0.1` 不一定能连到面板里的 MySQL，通常需要使用 1Panel/宝塔显示的数据库连接地址或容器名称。

## 9. 手动创建 systemd 服务

创建环境配置文件：

```bash
nano /etc/default/shiye-management-system
```

JSON 模式示例：

```ini
PORT="3388"
ADMIN_PATH="/admin"
DB_CLIENT="json"
APP_SECRET="请填写一个随机长字符串，重装时不要变"
```

MySQL 模式示例：

```ini
PORT="3388"
ADMIN_PATH="/admin"
DB_CLIENT="mysql"
APP_SECRET="请填写一个随机长字符串，重装时不要变"
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_USER="shiye"
MYSQL_PASSWORD="请换成强密码"
MYSQL_DATABASE="shiye_management"
MYSQL_CONNECTION_LIMIT="10"
# 可选：PM2 多进程、多实例或负载均衡时启用 Redis 共享登录态
REDIS_URL=""
SESSION_PREFIX="shiye:session:"
```

创建服务文件：

```bash
nano /etc/systemd/system/shiye-management-system.service
```

写入：

```ini
[Unit]
Description=Shiye Management System
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/shiye-management-system
EnvironmentFile=/etc/default/shiye-management-system
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
systemctl daemon-reload
systemctl enable shiye-management-system
systemctl restart shiye-management-system
systemctl status shiye-management-system
```

## 9. 配置 3-xui 节点

进入“3x-ui 节点”页面，点击“添加 3x-ui 节点”。

推荐使用 3-xui 3.4.1，并优先填写 API Token；账号密码可以留空。API Token 权限不足或版本接口差异时，可能会影响用户同步、入站创建、SOCKS 出站和路由规则写入。

如果你的 3-xui 地址是：

```text
http://example.com:2053/
```

填写：

```text
协议：http
地址：example.com
端口：2053
基础路径：/
账号：可留空
密码：可留空
API Token：填写 3-xui 的 API Token
```

如果你的 3-xui 地址是：

```text
https://example.com:2053/custompath/
```

填写：

```text
协议：https
地址：example.com
端口：2053
基础路径：/custompath
账号：可留空
密码：可留空
API Token：填写 3-xui 的 API Token
```

添加后点击“测试”。能显示可用 Inbound ID 就说明连接成功。

## 10. 创建用户并同步

进入“用户管理”，点击“新建用户”。

已有 3-xui 入站时：

```text
选择 3x-ui 节点
填写 Inbound ID
Client Email 可留空自动生成
UUID 可留空自动生成
设置用户登录账号和密码
设置续费价格
保存
点击同步
```

自动创建入站时：

```text
选择 3x-ui 节点
Inbound ID 留空
勾选自动创建入站
选择入站模板
端口可留空自动选择
保存
点击同步
```

自动创建入站会检查 3-xui 现有入站端口，避免端口冲突。

## 11. 用户充值续费

管理员在“卡密管理”里生成卡密，可以按分类复制或删除未使用卡密。

管理员在“系统设置”里填写购买卡密链接后，用户端点击“购买卡密”会跳转到这个链接。

用户从 `/` 登录后可以：

- 查看自己的余额
- 兑换卡密充值余额
- 查看自己的节点信息
- 使用余额续费当前节点

余额不足时不能续费。续费价格取自管理员给该用户设置的节点价格。

## 12. SOCKS 出站中转

进入“SOCKS 出站”，添加 SOCKS 节点。

然后编辑用户：

```text
启用 SOCKS 中转
选择 SOCKS 节点
保存
点击同步
```

同步时系统会写入 3-xui 的 Xray 模板：

- `outbounds` 添加 SOCKS 出站
- `routing.rules` 添加入站 tag 到 SOCKS tag 的规则
- 调用 Xray 重载接口

删除用户时，系统会尽量同步删除 3-xui 里的客户端、空入站、SOCKS 出站和对应路由规则。不同 3-xui 版本接口差异较大，建议删除后检查同步日志和 3-xui 后台。

## 13. 更新项目

推荐直接重新执行一键安装命令。脚本会覆盖程序文件，保留 `data/` 目录并重启服务。

如果使用 Git 部署，也可以手动更新：

```bash
cd /opt/shiye-management-system
git pull
npm install --omit=dev
node --check server.js
node --check public/app.js
systemctl restart shiye-management-system
journalctl -u shiye-management-system -n 80 --no-pager
```

## 14. 备份和恢复

MySQL 模式的数据表包括：

```text
shiye_settings
shiye_customers
shiye_xui_servers
shiye_socks_nodes
shiye_cards
shiye_sync_logs
shiye_meta
```

旧版兼容表 `shiye_app_state` 只作为迁移来源保留，新版本不会依赖它作为主存储。

JSON 模式需要备份：

```text
/opt/shiye-management-system/data/db.json
/opt/shiye-management-system/data/.secret
```

MySQL 模式需要备份：

```text
MySQL 数据库 shiye_management
/opt/shiye-management-system/data/.secret 或 /etc/default/shiye-management-system 里的 APP_SECRET
```

JSON 模式备份命令：

```bash
cd /opt/shiye-management-system
tar -czf /root/shiye-json-backup-$(date +%F).tar.gz data/db.json data/.secret
```

MySQL 模式备份命令：

```bash
mysqldump -u shiye -p shiye_management > /root/shiye-management-$(date +%F).sql
cp /etc/default/shiye-management-system /root/shiye-management-env-$(date +%F).bak
```

MySQL 模式恢复示例：

```bash
mysql -u shiye -p shiye_management < /root/shiye-management-日期.sql
cp /root/shiye-management-env-日期.bak /etc/default/shiye-management-system
systemctl restart shiye-management-system
```

如果丢失 `data/.secret` 或 `APP_SECRET`，之前保存的 3-xui Token、密码、SOCKS 密码将无法解密。

## 15. 可选：Nginx 反向代理

不会配置 Nginx 可以跳过这一节，直接使用：

```text
http://服务器IP:3388
```

安装 Nginx：

```bash
apt install -y nginx
```

示例配置：

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3388;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

检查并重载：

```bash
nginx -t
systemctl reload nginx
```

如果 `nginx -t` 提示某个旧配置文件不存在，先修复或删除那条旧 include，再重测。

## 16. 可选：HTTPS

如果你已经配置好域名和 Nginx，可以使用 Certbot：

```bash
apt update
apt install -y certbot python3-certbot-nginx
certbot --nginx -d example.com
```

HTTPS 不是系统运行的硬性要求，但公网使用时更推荐。

## 17. 安全建议

- 公网部署建议使用 MySQL。
- 公网部署建议修改默认管理员密码。
- 有条件建议使用 HTTPS。
- 不要公开 `data/db.json`、`data/.secret`、`/etc/default/shiye-management-system`。
- 不要公开 3-xui API Token。
- 如果不使用 Nginx，安全组需要放行 `3388`。
- 如果使用 Nginx，建议只放行 `80/443`，不要放行 `3388`。
