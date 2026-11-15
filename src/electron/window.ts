// The game in a window: the engine runs in a Node.js process of its own (its SQLite module is built for
// Node, not Electron), the terminal UI runs here and is drawn by xterm.js in the page, and pictures of
// the place and the people there, when the campaign has them, are shown beside it.
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import { loadConfig } from "../config.js";
import { spawnEngine } from "../engine/spawn.js";
import { runTui } from "../tui/run.js";
import { RemoteTerminal } from "../tui/terminal.js";
import { createAudio } from "../voice/audio.js";
import { artOf, watchViews } from "./art.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function main() {
  const config = loadConfig();
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workAreaSize;
  const size = { width: Math.min(1400, work.width), height: Math.min(900, work.height) };
  const window = new BrowserWindow({
    ...size,
    backgroundColor: "#16161e",
    title: "TUI RPG",
    webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  window.setMenuBarVisibility(false);

  const send = (channel: string, ...args: unknown[]) => {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args);
  };
  const terminal = new RemoteTerminal((data) => send("tty:output", data));
  const engine = spawnEngine({ node: process.env.TUI_RPG_NODE, onLog: (text) => process.stderr.write(text) });
  const game = watchViews(engine, (view) => send("art", artOf(view)));
  const audio = createAudio(config);

  let tui: ReturnType<typeof runTui> | undefined;
  ipcMain.on("tty:ready", (_event, columns: number, rows: number) => {
    terminal.resize(columns, rows);
    // A reloaded page gets the game as it is, drawn afresh.
    if (tui) return void terminal.stdout.emit("resize");
    tui = runTui(game, audio, terminal);
    void tui.waitUntilExit().finally(() => window.close());
  });
  ipcMain.on("tty:input", (_event, data: string) => terminal.input(data));
  ipcMain.on("tty:resize", (_event, columns: number, rows: number) => terminal.resize(columns, rows));

  let closing = false;
  window.on("close", () => {
    if (closing) return;
    closing = true;
    tui?.unmount();
  });
  app.on("window-all-closed", async () => {
    await audio.close();
    await game.close().catch(() => {});
    app.quit();
  });

  await window.loadFile(path.join(ROOT, "electron", "index.html"));
  // Some window systems (Wayland under WSLg) ignore the size the window was made with.
  const [width, height] = window.getSize();
  if (width < size.width && height < size.height) window.setSize(size.width, size.height);
}

main().catch((err: unknown) => {
  dialog.showErrorBox("TUI RPG", err instanceof Error ? err.message : String(err));
  app.exit(1);
});
