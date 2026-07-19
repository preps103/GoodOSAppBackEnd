const cwd = "/var/www/GoodAppBackEnd";
const runtimeUser = "goodapp";
const runtimeEnv = {
  NODE_ENV: "production",
  GOODOS_VOICE_DB_PATH: "/var/lib/goodapp-backend/goodos-voice-db.json"
};

const serviceDefaults = {
  cwd,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  min_uptime: "10s",
  max_restarts: 10,
  max_memory_restart: "512M",
  kill_timeout: 10000,
  uid: runtimeUser,
  gid: runtimeUser
};

module.exports = {
  apps: [
    {
      ...serviceDefaults,
      name: "goodapp-backend",
      script: "src/server.js",
      env: {
        ...runtimeEnv,
        PORT: 8001
      }
    },
    {
      ...serviceDefaults,
      name: "goodapp-backend-ha",
      script: "src/server.js",
      env: {
        ...runtimeEnv,
        PORT: 8002
      }
    },
    {
      ...serviceDefaults,
      name: "goodapp-worker-v3",
      script: "src/workers/goodapp-worker-v3.js",
      env: runtimeEnv
    }
  ]
};
