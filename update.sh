#!/usr/bin/env bash
# VPS 上一键更新：拉取最新代码 → 安装依赖 → 重启
set -e
cd "$(dirname "$0")"
git pull --ff-only
npm install --omit=dev
if pm2 describe unt-production >/dev/null 2>&1; then
  pm2 restart unt-production
else
  pm2 start ecosystem.config.js && pm2 save
fi
pm2 status unt-production
