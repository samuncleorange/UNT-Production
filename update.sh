#!/usr/bin/env bash
# VPS 上一键更新：拉取最新代码 → 安装依赖 → 重启服务
set -e
cd "$(dirname "$0")"
git pull --ff-only
npm install --omit=dev

if systemctl list-unit-files unt-production.service >/dev/null 2>&1 && systemctl is-enabled unt-production >/dev/null 2>&1; then
  sudo systemctl restart unt-production
  sleep 1
  systemctl --no-pager --lines=3 status unt-production || true
elif command -v pm2 >/dev/null 2>&1; then
  pm2 describe unt-production >/dev/null 2>&1 && pm2 restart unt-production || { pm2 start ecosystem.config.js && pm2 save; }
  pm2 status unt-production
else
  echo "尚未安装为服务，请先运行：sudo ./install-service.sh"
fi
