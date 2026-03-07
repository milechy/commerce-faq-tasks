module.exports = {
  apps: [
    {
      name: "rajiuce-api",
      script: "dist/index.js",
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
