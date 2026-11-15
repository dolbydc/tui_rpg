// The only things the window's page can do: draw what the game sends, and send back keys and its size.
import { contextBridge, ipcRenderer } from "electron";
import type { Art } from "./art.js";

const bridge = {
  /** The terminal's size once it's laid out; the game starts drawing then. */
  ready: (columns: number, rows: number) => ipcRenderer.send("tty:ready", columns, rows),
  input: (data: string) => ipcRenderer.send("tty:input", data),
  resize: (columns: number, rows: number) => ipcRenderer.send("tty:resize", columns, rows),
  onOutput: (listener: (data: string) => void) => ipcRenderer.on("tty:output", (_event, data: string) => listener(data)),
  /** Pictures of where the player is and who's there, after each turn. */
  onArt: (listener: (art: Art) => void) => ipcRenderer.on("art", (_event, art: Art) => listener(art)),
};

export type Bridge = typeof bridge;

contextBridge.exposeInMainWorld("rpg", bridge);
