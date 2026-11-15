import { useEffect, useState } from "react";
import { Text, useApp } from "ink";
import type { Game, Opened } from "../engine/api.js";
import type { MusicPlayer } from "../voice/music.js";
import type { VoiceOver } from "../voice/voice-over.js";
import { App } from "./app.js";
import { menuItems, StartMenu, type MenuChoice, type MenuItem } from "./menu.js";

type Screen =
  | { kind: "loading" }
  | { kind: "menu"; items: MenuItem[]; notice?: string }
  | { kind: "game"; opened: Opened; key: number };

/** The start menu, then the game chosen there; /new comes back to the menu. */
export function Root({ game, voice, music }: { game: Game; voice: VoiceOver; music: MusicPlayer }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  async function showMenu(notice?: string) {
    voice.stop();
    music.play(undefined);
    try {
      const { campaigns, saves } = await game.library();
      setScreen({ kind: "menu", items: menuItems(campaigns, saves), notice });
    } catch (err) {
      setScreen({ kind: "menu", items: menuItems([], []), notice: `The game couldn't start: ${message(err)}` });
    }
  }

  useEffect(() => {
    void showMenu();
  }, []);

  async function choose(choice: MenuChoice) {
    if (choice.kind === "quit") return exit();
    setScreen({ kind: "loading" });
    let opened: Opened;
    try {
      opened = await game.open(choice.campaignId, choice.kind);
    } catch (err) {
      return showMenu(`Couldn't open that campaign: ${message(err)}`);
    }
    voice.use(opened.cast);
    setScreen({ kind: "game", opened, key: Date.now() });
  }

  switch (screen.kind) {
    case "loading":
      return <Text dimColor>…</Text>;
    case "menu":
      return <StartMenu items={screen.items} notice={screen.notice} onChoose={(c) => void choose(c)} />;
    case "game":
      return (
        <App
          key={screen.key}
          game={game}
          opened={screen.opened}
          voice={voice}
          music={music}
          onMenu={() => void showMenu()}
        />
      );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
