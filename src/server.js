const app = require("./app");
const env = require("./config/env");

app.listen(env.port, "127.0.0.1", () => {
  console.log(`${env.serviceName} running on http://127.0.0.1:${env.port}`);
});
