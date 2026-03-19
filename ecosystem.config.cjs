// /opt/rajiuce/.env を読んで avatar プロセスに明示的に渡す
// （PM2 は python プロセスの dotenv を自動実行しないため）
const fs = require("fs");
function parseEnvFile(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, "utf8")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; })
    );
  } catch (_) { return {}; }
}
// avatar-agent/.env を優先し、なければ /opt/rajiuce/.env にフォールバック
const _avatarEnv = parseEnvFile("/opt/rajiuce/avatar-agent/.env");
const _rootEnv   = parseEnvFile("/opt/rajiuce/.env");
const _vpsEnv    = Object.assign({}, _rootEnv, _avatarEnv);  // avatar-agent/.env が優先

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
      args: "/opt/rajiuce/avatar-agent/agent.py start",
      cwd: "/opt/rajiuce/avatar-agent",
      interpreter: "none",
      env: {
        LIVEKIT_URL:        _vpsEnv.LIVEKIT_URL        || process.env.LIVEKIT_URL        || "",
        LIVEKIT_API_KEY:    _vpsEnv.LIVEKIT_API_KEY    || process.env.LIVEKIT_API_KEY    || "",
        LIVEKIT_API_SECRET: _vpsEnv.LIVEKIT_API_SECRET || process.env.LIVEKIT_API_SECRET || "",
        GROQ_API_KEY:       _vpsEnv.GROQ_API_KEY       || process.env.GROQ_API_KEY       || "",
        FISH_AUDIO_API_KEY: _vpsEnv.FISH_AUDIO_API_KEY || process.env.FISH_AUDIO_API_KEY || "",
        LEMONSLICE_AGENT_ID: _vpsEnv.LEMONSLICE_AGENT_ID || process.env.LEMONSLICE_AGENT_ID || "",
        LIBVA_DRIVER_NAME: "dummy",
      },
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
