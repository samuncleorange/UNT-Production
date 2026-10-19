#!/usr/bin/env bash
# 安装为 systemd 服务：开机自启、崩溃自动重启。
# 用法（在项目目录下）：sudo ./install-service.sh
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo ./install-service.sh"; exit 1
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null || command -v node || true)"
SERVICE=unt-production

if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js 18+"; exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "未找到 .env，先执行：cp .env.example .env 并修改配置"; exit 1
fi
if [ ! -d "$APP_DIR/node_modules" ]; then
  sudo -u "$RUN_USER" bash -lc "cd '$APP_DIR' && npm install --omit=dev"
fi

# 如果之前用 pm2 跑过，先停掉，避免端口冲突
if sudo -u "$RUN_USER" bash -lc 'command -v pm2' >/dev/null 2>&1; then
  sudo -u "$RUN_USER" bash -lc "pm2 delete $SERVICE && pm2 save" >/dev/null 2>&1 || true
fi

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=UNT 产能识别网站
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now $SERVICE
sleep 1
systemctl --no-pager --lines=5 status $SERVICE || true

PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2)
echo
echo "已安装并启动，开机会自动运行。访问：http://服务器IP:${PORT:-3000}"
echo "常用命令："
echo "  查看状态  systemctl status $SERVICE"
echo "  查看日志  journalctl -u $SERVICE -f"
echo "  重启      sudo systemctl restart $SERVICE"
