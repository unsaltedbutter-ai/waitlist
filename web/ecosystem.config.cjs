// PM2 process config for UnsaltedButter.ai
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "unsaltedbutter",
      script: "node_modules/.bin/next",
      args: "start -p 3000",
      cwd: "/home/butter/unsaltedbutter/web",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      // Process management
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "512M",
      // Logs
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/home/butter/.pm2/logs/unsaltedbutter-error.log",
      out_file: "/home/butter/.pm2/logs/unsaltedbutter-out.log",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
  ],
};
