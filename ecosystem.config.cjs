module.exports = {
  apps: [
    {
      name: "rajiuce-api",
      script: "dist/src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=512",
      env_production: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      max_memory_restart: "512M",
    },
    {
      name: "rajiuce-avatar",
      script: "/opt/rajiuce/avatar-agent/venv/bin/python",
      args: "/opt/rajiuce/avatar-agent/agent.py dev",
      cwd: "/opt/rajiuce/avatar-agent",
      interpreter: "none",
      env: {},
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
    {
      name: "rajiuce-admin",
      script: "serve",
      args: "-s admin-ui/dist -l 5173",
      cwd: __dirname,
      interpreter: "none",
      env_production: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};
