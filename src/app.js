const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const routes = require("./routes");
const requestLogger = require("./middleware/requestLogger");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const app = express();
const allowedOrigins = [
  "https://app.goodos.app",
  "https://backend.goodos.app",
  "https://fleet.goodos.app",
  "https://qr.goodos.app",
  "https://ads.goodos.app",
  "https://boost.goodos.app",
  "https://customs.goodos.app",
  "https://designer.goodos.app",
  "https://editor.goodos.app",
  "https://escrow.goodos.app",
  "https://scan.goodos.app",
  "https://speech.goodos.app",
  "https://swapz.goodos.app",
  "https://trust.goodos.app",
];

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const url = new URL(origin);

    if (url.hostname === "goodos.app") return true;
    if (url.hostname.endsWith(".goodos.app")) return true;
    if (url.hostname === "localhost") return true;
    if (url.hostname === "127.0.0.1") return true;

    return allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}


app.set("trust proxy", 1);

app.use(helmet());

app.use(
  cors({
    origin: function (origin, callback) {
      if (env.isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(requestLogger);

app.use(routes);

app.use(notFound);
app.use(errorHandler);


// GoodOS landing route 26A
app.get("/", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/landing.html"));
});

app.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/console.html"));
});

module.exports = app;