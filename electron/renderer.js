// The window's page: an xterm.js terminal the game draws in, and the pictures beside it. Everything it
// can do goes through window.rpg (src/electron/preload.cts).
import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";

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
new ResizeObserver(() => fit.fit()).observe(container);
rpg.ready(terminal.cols, terminal.rows);
terminal.focus();
window.addEventListener("focus", () => terminal.focus());

const art = document.getElementById("art");
const place = document.getElementById("place");
const people = document.getElementById("people");

/** Shows the pictures the campaign has of where the player is and who's there; none, and the pane goes. */
rpg.onArt(({ place: here, people: present }) => {
  place.hidden = !here?.url;
  if (here?.url) {
    place.querySelector("img").src = here.url;
    place.querySelector("img").alt = here.name;
    place.querySelector("figcaption").textContent = here.name;
  }
  people.replaceChildren(
    ...present
      .filter((person) => person.url)
      .map((person) => {
        const item = document.createElement("li");
        const img = Object.assign(document.createElement("img"), { src: person.url, alt: person.appearance });
        const label = Object.assign(document.createElement("div"), { className: "label", textContent: capitalize(person.label) });
        const appearance = Object.assign(document.createElement("div"), { className: "appearance", textContent: person.appearance });
        item.append(img, label, appearance);
        return item;
      }),
  );
  art.hidden = place.hidden && people.childElementCount === 0;
});

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
