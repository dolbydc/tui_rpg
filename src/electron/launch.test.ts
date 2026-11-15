import assert from "node:assert/strict";
import { test } from "node:test";
import { windowSystemArgs } from "./launch.js";

test("under WSL with Wayland, the window runs on Wayland, unless asked otherwise", () => {
  const wsl = { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" };
  assert.deepEqual(windowSystemArgs(wsl, "linux", []), ["--ozone-platform=wayland"]);
  assert.deepEqual(windowSystemArgs({ ...wsl, TUI_RPG_OZONE: "x11" }, "linux", []), []);
  assert.deepEqual(windowSystemArgs(wsl, "linux", ["--ozone-platform=x11"]), [], "your own choice stands");
  assert.deepEqual(windowSystemArgs({ WAYLAND_DISPLAY: "wayland-0" }, "linux", []), [], "not WSL: Electron decides");
  assert.deepEqual(windowSystemArgs(wsl, "win32", []), []);
});
