# 十夜管理系统

十夜管理系统是一个对接 3-xui 的用户节点管理面板，用于管理用户资料、续费、到期停用、3-xui 节点同步、自动创建入站和 SOCKS 出站中转。

本项目基于 3-xui 面板 3.4.1 版本开发和测试。其他 3-xui 版本通常也可以接入，但不同版本或魔改版的 API 路径、返回字段可能存在差异，建议优先使用 3.4.1 或自行测试兼容性。

## 功能

- 用户资料、套餐、金额、到期时间、流量限制管理
- 用户续费、启用、停用、过期批量停用
- 多个 3-xui 节点管理
- 多个 SOCKS 出站管理
- 同步用户到 3-xui client
- 支持自动创建 VLESS 入站
- 入站模板：TCP、Reality、TLS、WebSocket、gRPC
- Reality/TLS 默认 ALPN：`h3`、`h2`、`http/1.1`
- SOCKS 中转会写入 Xray outbound 和 routing rule
- 管理员账号密码修改
- 敏感字段本地加密保存

## 一键安装

服务器执行：

```bash
REPO_URL=https://github.com/wstimin/3-xuiguanlimianban.git bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanlimianban/main/install.sh)
```

如果你 Fork 了本项目，把命令里的仓库地址改成自己的；如果默认分支不是 `main`，也要把链接里的 `main` 改成实际分支名。

安装完成后访问：

```text
http://服务器IP:3388
```

已经安装过也可以重新执行一键安装命令更新程序。脚本会保留 `data/` 目录，不会覆盖已有用户数据、管理员密码、3-xui Token 和 SOCKS 密码。

默认账号：

```text
账号：admin
密码：admin123
```

系统允许继续使用默认密码，但公网部署建议登录后到“账号安全”修改。

## 手动运行

```bash
node --check server.js
node --check public/app.js
npm start
```

指定端口：

```bash
PORT=3388 npm start
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

## 数据文件

程序数据保存在：

```text
data/db.json
```

加密密钥保存在：

```text
data/.secret
```

备份时必须同时备份这两个文件。丢失 `data/.secret` 后，已保存的 3-xui Token、密码、SOCKS 密码将无法解密。

## 安全建议

- 公网部署建议修改默认密码
- 有条件建议配置 Nginx/Caddy + HTTPS
- 不要公开 `data/db.json` 和 `data/.secret`
- 不要把 3-xui API Token 发给不可信的人
- 服务器安全组只开放必要端口

## 详细教程

查看 [部署教程.md](./部署教程.md)。
