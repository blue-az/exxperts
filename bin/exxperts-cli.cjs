#!/usr/bin/env node
// Explicit Exxperts-named alias for the exxperts CLI/TUI runtime.
require("./lib/exxcode-launcher.cjs").main(process.argv.slice(2), "exxperts-cli").catch((err) => {
  console.error(err);
  process.exit(1);
});
