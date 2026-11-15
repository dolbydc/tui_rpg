// Starts the window (`npm run electron`). Under WSL it runs Electron on Wayland: on WSLg's X11, Chromium's
// mouse pointer goes missing over the window. That has to be a command-line switch; set from the main
// script, the window system has already been chosen. TUI_RPG_OZONE=x11 keeps X11; an --ozone-platform of
// your own is passed on as it is.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** In Node, the electron package is the path of its binary. */
const electron = createRequire(import.meta.url)("electron") as string;
const main = fileURLToPath(new URL("./main.js", import.meta.url));
const args = process.argv.slice(2);

export function windowSystemArgs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, given: string[]): string[] {
  const wsl = platform === "linux" && Boolean(env.WSL_DISTRO_NAME) && Boolean(env.WAYLAND_DISPLAY);
  if (!wsl || env.TUI_RPG_OZONE === "x11" || given.some((a) => a.startsWith("--ozone-platform"))) return [];
  return ["--ozone-platform=wayland"];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(electron, [...windowSystemArgs(process.env, process.platform, args), main, ...args], { stdio: "inherit" });
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
}
