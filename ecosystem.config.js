// pm2 启动配置：pm2 start ecosystem.config.js
module.exports = {
  apps: [{ name: 'unt-production', script: 'server.js', instances: 1, autorestart: true, max_memory_restart: '400M' }],
};
