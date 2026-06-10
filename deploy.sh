#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
git pull
cd server
npm install --no-fund --no-audit
cd ../client
npm install --no-fund --no-audit
npm run build
cd ..
pm install -g pm2
pm2 restart home-dashboard || pm2 start server/index.js --name home-dashboard
pm2 save
