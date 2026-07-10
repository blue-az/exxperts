// Interactive room picker for the rooms-only exxperts CLI. Self-contained
// (raw-TTY arrow selector), styled with the same brand ANSI as the launcher
// banner. It does not spawn an agent — it just returns the chosen action so the
// launcher can boot the selected room via the existing room-boot path.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// Enumerate rooms straight from product state. Each room is a directory under
// personalized-agents/ with an agent.json (id, displayName, status). This avoids
// spawning the runtime just to list rooms; readiness is validated on entry.
function listRooms(personalizedAgentsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(personalizedAgentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rooms = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(personalizedAgentsDir, entry.name, "agent.json"), "utf8"));
      if (meta && meta.id && meta.status !== "archived") {
        rooms.push({
          id: String(meta.id),
          displayName: String(meta.displayName || meta.id).trim() || String(meta.id),
          status: String(meta.status || "unknown"),
        });
      }
    } catch {}
  }
  rooms.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rooms;
}

// Render an interactive selector and resolve with the chosen action:
//   { action: "enter", agentId } | { action: "create" } | { action: "quit" }
function runRoomPicker({ rooms, brand, wordmark }) {
  const { R, B, D, lila } = brand;
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stderr;
    if (!stdin.isTTY) {
      resolve({ action: "quit" });
      return;
    }

    const items = [
      ...rooms.map((room) => ({ type: "room", room })),
      { type: "create" },
      { type: "quit" },
    ];
    let index = 0;
    let rendered = 0;

    const renderItem = (item, selected) => {
      const pointer = selected ? `${lila}›${R} ` : "  ";
      if (item.type === "room") {
        const name = selected ? `${lila}${item.room.displayName}${R}` : item.room.displayName;
        const tag =
          item.room.status === "needs_absorb"
            ? `  ${D}· needs maintenance (web app)${R}`
            : item.room.status !== "ready"
              ? `  ${D}· ${item.room.status}${R}`
              : "";
        return `  ${pointer}${name}${tag}`;
      }
      if (item.type === "create") {
        const label = "＋ Create a new room";
        return `  ${pointer}${selected ? `${lila}${label}${R}` : `${D}${label}${R}`}`;
      }
      return `  ${pointer}${selected ? `${lila}Quit${R}` : `${D}Quit${R}`}`;
    };

    const render = (first) => {
      const lines = [""];
      if (wordmark) lines.push(...String(wordmark).split("\n"), "");
      else lines.push(`  ${B}${lila}exxperts${R}`);
      lines.push(`  ${D}your rooms · pick one or create a new one${R}`, "");
      if (rooms.length === 0) {
        lines.push(`  ${D}No rooms yet. Create your first one.${R}`, "");
      }
      items.forEach((item, i) => lines.push(renderItem(item, i === index)));
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

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + items.length) % items.length;
        render(false);
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % items.length;
        render(false);
      } else if (key.name === "return" || key.name === "enter") {
        const item = items[index];
        cleanup();
        if (item.type === "room") resolve({ action: "enter", agentId: item.room.id });
        else if (item.type === "create") resolve({ action: "create" });
        else resolve({ action: "quit" });
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve({ action: "quit" });
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

// Single-line prompt (used by the create flow). Assumes raw mode is OFF.
function promptLine(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(query, (answer) => {
      rl.close();
      resolve(String(answer ?? "").trim());
    });
  });
}

module.exports = { listRooms, runRoomPicker, promptLine };
