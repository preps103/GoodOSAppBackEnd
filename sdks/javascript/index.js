"use strict";

const { GoodbaseTelemetry } = require("./telemetry");
module.exports = { ...require("./client"), GoodbaseTelemetry, ...require("./react"), ...require("./nextjs") };
