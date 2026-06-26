module.exports = {
  apps: [
    {
      name: "goodapp-backend",
      script: "src/server.js",
      cwd: "/var/www/GoodAppBackEnd",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 8001
      }
    }
  ]
};
