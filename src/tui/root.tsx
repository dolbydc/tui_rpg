import { useEffect, useState } from "react";
import { Text, useApp } from "ink";
import type { LogLine } from "../domain/types.js";
import type { CampaignLibrary, OpenCampaign } from "../game/campaigns.js";
import type { MusicPlayer } from "../voice/music.js";
import type { VoiceOver } from "../voice/voice-over.js";
import { App } from "./app.js";
import { menuItems, StartMenu, type MenuChoice, type MenuItem } from "./menu.js";

type Screen =
  | { kind: "loading" }
  | { kind: "menu"; items: MenuItem[]; notice?: string }
  | { kind: "game"; campaign: OpenCampaign; initial: LogLine[]; readAloud: boolean; key: number };

/** The start menu, then the game chosen there; /new comes back to the menu. */
export function Root({ library, voice, music }: { library: CampaignLibrary; voice: VoiceOver; music: MusicPlayer }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  async function showMenu(notice?: string) {
    voice.stop();
    music.play(undefined);
    setScreen({ kind: "menu", items: menuItems(library.campaigns, await library.saves()), notice });
  }

  useEffect(() => {
    void showMenu();
  }, []);

  async function choose(choice: MenuChoice) {
    if (choice.kind === "quit") return exit();
    setScreen({ kind: "loading" });
    let campaign: OpenCampaign;
    try {
      campaign = await library.get(choice.campaignId);
    } catch (err) {
      return showMenu(`Couldn't open that campaign: ${err instanceof Error ? err.message : String(err)}`);
    }
    voice.use(campaign.world.world);
    const resumed = choice.kind === "continue" ? await campaign.session.resume() : undefined;
    // A saved game that's gone missing since the menu was drawn gets a new character, like any new game.
    const initial = resumed ?? campaign.session.newCharacter();
    setScreen({ kind: "game", campaign, initial, readAloud: !resumed, key: Date.now() });
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
          session={screen.campaign.session}
          initial={screen.initial}
          voice={voice}
          music={music}
          readAloud={screen.readAloud}
          onMenu={() => void showMenu()}
        />
      );
  }
}
