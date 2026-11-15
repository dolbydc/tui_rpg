// The window's page: the picture of the place, the story in an xterm.js terminal the game draws in, and the
// panels down the side. Everything it can do goes through window.rpg (src/electron/preload.cts).
import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { drawScene, drawSidebar, setUpMapOverlay } from "./panels.js";

const rpg = window.rpg;

const terminal = new Terminal({
  fontFamily: '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
  fontSize: 15,
  cursorBlink: false,
  // A real terminal turns each newline into a carriage return and a newline (onlcr); Ink relies on that.
  convertEol: true,
  // Ink redraws the whole screen in place; there's nothing to scroll back to.
  scrollback: 0,
  theme: {
    background: "#16161e",
    foreground: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
  },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
const container = document.getElementById("terminal");
terminal.open(container);
fit.fit();

rpg.onOutput((data) => terminal.write(data));
terminal.onData((data) => rpg.input(data));
terminal.onResize(({ cols, rows }) => rpg.resize(cols, rows));
// The terminal is resized whenever the window is, or the picture comes or goes.
new ResizeObserver(() => fit.fit()).observe(container);
rpg.ready(terminal.cols, terminal.rows);
terminal.focus();
window.addEventListener("focus", () => terminal.focus());
// Clicking anywhere goes back to typing.
document.addEventListener("mouseup", () => {
  if (!window.getSelection()?.toString()) terminal.focus();
});

setUpMapOverlay(() => terminal.focus());

rpg.onView((view) => {
  drawScene(view.player);
  drawSidebar(view.player);
});
