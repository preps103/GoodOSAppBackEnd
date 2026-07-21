import { GoodOSClient } from "../../../src/public/sdk/goodos.js";

export const goodbase = new GoodOSClient({
  rootUrl: import.meta.env.VITE_GOODBASE_URL || "https://base.goodos.app",
  apiKey: import.meta.env.VITE_GOODBASE_PUBLIC_KEY || "",
});

