#!/usr/bin/env node
// Compatibility alias for the exxperts rooms CLI.
require("./lib/exxcode-launcher.cjs").main(process.argv.slice(2), "exxcode").catch((err) => {
  console.error(err);
  process.exit(1);
});
