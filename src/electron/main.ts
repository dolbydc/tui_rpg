// The Electron frontend's main process. Colour is decided when Ink's colouring loads, from this process's
// stdout, which isn't the terminal the game is drawn in; so it's forced first, and the rest loaded after.
process.env.FORCE_COLOR ??= "3";
await import("./window.js");
