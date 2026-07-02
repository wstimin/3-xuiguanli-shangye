# 十夜管理系统

十夜管理系统是一个对接 3-xui 的用户节点管理面板，用于管理用户资料、续费、到期停用、3-xui 节点同步、自动创建入站和 SOCKS 出站中转。

本项目基于 3-xui 面板 3.4.1 版本开发和测试。其他 3-xui 版本通常也可以接入，但不同版本或魔改版的 API 路径、返回字段可能存在差异，建议优先使用 3.4.1 或自行测试兼容性。

## 功能

- 用户资料、节点价格、到期时间、流量限制管理
- 用户续费、启用、停用、过期批量停用
- 用户端支持卡密充值、余额续费，只能查看自己的节点和账户记录
- 管理员可手动增加、扣减或设置用户余额，并自动生成余额流水
- 财务流水：记录卡密充值、用户续费扣款、管理员余额调整
- 续费记录：记录用户自助续费和管理员后台续费
- 卡密批次管理：按批次生成、追加生成、复制、重命名和删除未使用卡密
- 多个 3-xui 节点管理
- 多个 SOCKS 出站管理
- 同步用户到 3-xui client
- 支持自动创建 VLESS 入站
- 入站模板：TCP、Reality、TLS、WebSocket、gRPC
- Reality/TLS 默认 ALPN：`h3`、`h2`、`http/1.1`
- SOCKS 中转会写入 Xray outbound 和 routing rule
- 用户入口和管理员入口分离，默认管理员入口为 `/admin`
- 支持 `ADMIN_PATH` 自定义管理员后台路径
- 支持 MySQL 分表存储，公开运营时比 JSON 文件更适合并发和备份
- 管理员账号密码修改
- 敏感字段本地加密保存

## 一键安装

测试或个人使用可以直接执行：

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

安装完成后访问：

```text
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
```

如果要更换管理员入口，把 `ADMIN_PATH=/admin` 改成自己的路径，例如 `ADMIN_PATH=/myadmin2026`。

重新部署时可以重新执行一键安装命令。脚本会覆盖程序文件、保留 `data/` 目录并重启服务。使用 MySQL 时，业务数据保存在 MySQL 中，服务密钥会写入 `/etc/default/shiye-management-system`。

默认账号：

```text
账号：admin
密码：admin123
```

系统允许继续使用默认密码，但公网部署建议登录后到“账号安全”修改。

## 网页安装向导

1Panel、宝塔等面板部署时，可以不在面板里手动添加环境变量。上传项目并启动 Node.js 后，首次访问会进入安装向导，填写 MySQL 信息即可自动测试连接、创建数据库表并完成安装。

需要准备的信息：

```text
数据库地址
数据库端口
数据库名称
数据库账号
数据库密码
```

如果数据库账号有建库权限，向导会尝试自动创建数据库；如果没有建库权限，请先在 1Panel/宝塔里创建数据库和账号，再把信息填到向导里。

## 手动运行

```bash
node --check server.js
node --check public/app.js
npm start
```

不传数据库环境变量时，首次访问会进入网页安装向导，适合 1Panel、宝塔等面板上传部署后在网页里绑定 MySQL。

指定端口：

```bash
PORT=3388 npm start
```

如果只是本地测试并想使用 JSON 文件模式，需要显式指定：

```bash
DB_CLIENT=json PORT=3388 npm start
```

## systemd 常用命令

一键脚本会创建服务：

```text
shiye-management-system
```

常用命令：

```bash
systemctl status shiye-management-system
systemctl restart shiye-management-system
journalctl -u shiye-management-system -f
```

## 3-xui 节点填写说明

本系统按 3-xui 3.4.1 的 API 进行适配，并兼容部分旧版接口。推荐在 3-xui 后台开启并填写 API Token。

如果你的 3-xui 面板访问地址是：

```text
http://example.com:2053/
```

填写：

```text
协议：http
地址：example.com
端口：2053
基础路径：/
API Token：填写 3-xui 里的 API Token
```

如果你的 3-xui 面板访问地址是：

```text
https://example.com:2053/panelpath/
```

填写：

```text
协议：https
地址：example.com
端口：2053
基础路径：/panelpath
API Token：填写 3-xui 里的 API Token
```

账号和密码可以留空，推荐使用 API Token。

## 数据存储

公开运营推荐 MySQL：

```text
DB_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=shiye
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=shiye_management
```

面板上传部署不配置 MySQL 环境变量时，会进入网页安装向导；只有显式设置 `DB_CLIENT=json` 时才会使用 JSON 兼容模式，适合测试或个人使用。

MySQL 模式会创建分表保存用户、3-xui 节点、SOCKS 节点、卡密、卡密批次、余额流水、续费记录、同步日志和系统设置。旧版一行 JSON 数据或 `data/db.json` 会在首次启动时自动迁移到分表。

主要业务表包括：

```text
shiye_customers
shiye_xui_servers
shiye_socks_nodes
shiye_cards
shiye_card_batches
shiye_balance_logs
shiye_renewal_logs
shiye_sync_logs
shiye_settings
```

JSON 兼容模式数据保存在：

```text
data/db.json
```

加密密钥来自 `APP_SECRET`，一键脚本会写入：

```text
/etc/default/shiye-management-system
```

兼容旧版本时，也可能保存在：

```text
data/.secret
```

备份时 MySQL 模式需要备份数据库和 `/etc/default/shiye-management-system`；JSON 模式需要备份 `data/db.json` 以及 `APP_SECRET` 或 `data/.secret`。丢失密钥后，已保存的 3-xui Token、密码、SOCKS 密码将无法解密。

## 管理员入口

默认管理员后台路径：

```text
/admin
```

用户入口是网站根路径 `/`。管理员账号只能在管理员入口登录，普通用户只能在用户入口登录。

## 并发说明

MySQL 模式使用分表存储，并通过事务保护卡密兑换、用户余额和续费等关键写入。卡密管理、3-xui 节点配置、SOCKS 配置、系统设置等后台本地操作会按单表增量写入；用户余额、续费、用户资料、删除用户和 3-xui 远程同步类操作仍会串行保护，优先避免余额和远程节点状态写乱。

默认 Session 保存在当前 Node.js 进程内，单进程部署即可使用。如果要用 PM2 多进程、多实例或负载均衡，建议配置 Redis 共享 Session：

```text
REDIS_URL=redis://127.0.0.1:6379
SESSION_PREFIX=shiye:session:
```

当前版本已经适合小中型公开面板使用；更大规模并发时建议使用 MySQL + Redis，并把多个 3-xui 远程同步任务拆成后台队列。

## 安全建议

- 公网部署建议修改默认密码
- 有条件建议配置 Nginx/Caddy + HTTPS
- 不要公开 `data/db.json` 和 `data/.secret`
- 不要把 3-xui API Token 发给不可信的人
- 服务器安全组只开放必要端口

## 详细教程

查看 [部署教程.md](./部署教程.md)。
