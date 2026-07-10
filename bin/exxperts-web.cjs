#!/usr/bin/env node
// Compatibility/dev alias for the exxperts web app launcher.
require("./lib/web-launcher.cjs").main(process.argv.slice(2), "exxperts-web");
