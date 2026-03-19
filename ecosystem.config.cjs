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
      // serve の PATH 解決が不安定なため絶対パスで指定
      name: "rajiuce-admin",
      script: "/usr/bin/serve",
      args: "-s /opt/rajiuce/admin-ui/dist -l 5173",
      cwd: "/opt/rajiuce",
      interpreter: "none",
      env_production: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
    {
      // slack_listener.py は SCRIPTS/deploy-slack-listener.sh でデプロイされる
      name: "slack-listener",
      script: "/opt/rajiuce/slack-listener/slack_listener.py",
      interpreter: "python3",
      cwd: "/opt/rajiuce/slack-listener",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
