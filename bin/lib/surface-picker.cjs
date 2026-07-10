// Interactive surface picker for bare `exxperts`: choose the web app
// (recommended) or the rooms CLI/TUI. Same self-contained raw-TTY arrow
// selector and brand ANSI as the room picker; it does not spawn anything
// itself — it launches the chosen surface via the existing launchers.
const readline = require("node:readline");
const { BRAND, brandWordmark } = require("./exxcode-launcher.cjs");

const ITEMS = [
  { key: "web", label: "Web app", tag: "rooms in your browser", badge: "recommended" },
  { key: "cli", label: "CLI", tag: "rooms in this terminal" },
  { key: "quit", label: "Quit", tag: "" },
];
const LABEL_WIDTH = Math.max(...ITEMS.map((item) => item.label.length));

// Render the selector and resolve with "web" | "cli" | "quit".
function pickSurface() {
  const { R, D, lila } = BRAND;
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stderr;
    if (!stdin.isTTY) {
      resolve("quit");
      return;
    }

    let index = 0;
    let rendered = 0;

    const renderItem = (item, selected) => {
      const { yellow } = BRAND;
      const pointer = selected ? `${lila}›${R} ` : "  ";
      const padded = item.label.padEnd(LABEL_WIDTH);
      const name = selected ? `${lila}${padded}${R}` : item.key === "quit" ? `${D}${padded}${R}` : padded;
      const tag = item.tag ? `  ${D}· ${item.tag}${R}` : "";
      const badge = item.badge ? ` ${D}·${R} ${yellow}${item.badge}${R}` : "";
      return `  ${pointer}${name}${tag}${badge}`;
    };

    const render = (first) => {
      const lines = ["", ...brandWordmark(2).split("\n"), ""];
      lines.push(`  ${D}how do you want to open your rooms?${R}`, "");
      ITEMS.forEach((item, i) => lines.push(renderItem(item, i === index)));
      lines.push("", `  ${D}↑/↓ select · enter open · q quit${R}`);

      if (!first) out.write(`\x1b[${rendered}A`);
      out.write(lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
      rendered = lines.length;
    };

    const cleanup = () => {
      try { stdin.setRawMode(false); } catch {}
      stdin.removeListener("keypress", onKey);
      stdin.pause();
      out.write("\x1b[?25h"); // show cursor
    };

    const choose = (key) => {
      cleanup();
      resolve(key);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + ITEMS.length) % ITEMS.length;
        render(false);
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % ITEMS.length;
        render(false);
      } else if (key.name === "return" || key.name === "enter") {
        choose(ITEMS[index].key);
      } else if (key.name === "w" || key.name === "1") {
        choose("web");
      } else if (key.name === "c" || key.name === "2") {
        choose("cli");
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        choose("quit");
      }
    };

    readline.emitKeypressEvents(stdin);
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    out.write("\x1b[2J\x1b[H"); // clear screen so the picker starts clean
    out.write("\x1b[?25l"); // hide cursor
    render(true);
    stdin.on("keypress", onKey);
  });
}

async function main() {
  const choice = await pickSurface();
  if (choice === "web") return require("./web-launcher.cjs").main([], "exxperts web");
  if (choice === "cli") return require("./exxcode-launcher.cjs").main([], "exxperts cli");
  process.exit(0);
}

module.exports = { main, pickSurface };
