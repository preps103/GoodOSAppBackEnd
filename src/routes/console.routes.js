const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/", (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://backend.goodos.app; font-src 'self' https: data:;"
  );

  return res.sendFile(path.join(__dirname, "../public/console.html"));
});

module.exports = router;
