#!/usr/bin/env node
import { startStdioServer } from "./server.js";

startStdioServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
