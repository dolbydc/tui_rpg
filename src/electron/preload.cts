// The only things the window's page can do: draw what the game sends, and send back keys and its size.
import { contextBridge, ipcRenderer } from "electron";
import type { Activity } from "../domain/types.js";
import type { PageView } from "./page.js";

const bridge = {
  /** The terminal's size once it's laid out; the game starts drawing then. */
  ready: (columns: number, rows: number) => ipcRenderer.send("tty:ready", columns, rows),
  input: (data: string) => ipcRenderer.send("tty:input", data),
  resize: (columns: number, rows: number) => ipcRenderer.send("tty:resize", columns, rows),
  onOutput: (listener: (data: string) => void) => ipcRenderer.on("tty:output", (_event, data: string) => listener(data)),
  /** The game as it stands, to draw the picture and panels from: after each turn, and when it changes between. */
  onView: (listener: (view: PageView) => void) => ipcRenderer.on("view", (_event, view: PageView) => listener(view)),
  /** One of the game's minds at work: a model call starting or ending, or something passed between them. */
  onActivity: (listener: (activity: Activity) => void) =>
    ipcRenderer.on("activity", (_event, activity: Activity) => listener(activity)),
  /** Opens the minds in a window of their own (or brings it to the front). */
  openMinds: () => ipcRenderer.send("minds:open"),
  /** The minds window is ready: it's sent the game as it stands, and what's happened lately. */
  mindsReady: () => ipcRenderer.send("minds:ready"),
  /** What the minds did before the window opened, oldest first. */
  onHistory: (listener: (history: Activity[]) => void) =>
    ipcRenderer.on("minds:history", (_event, history: Activity[]) => listener(history)),
};

export type Bridge = typeof bridge;

contextBridge.exposeInMainWorld("rpg", bridge);
