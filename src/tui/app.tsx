import { useEffect, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import type { LogLine } from "../domain/types.js";
import type { SessionController } from "../game/session.js";
import type { MusicPlayer } from "../voice/music.js";
import type { VoiceOver } from "../voice/voice-over.js";
import { EMPTY_LINE, editLine, type LineState } from "./line-editor.js";
import { CharacterSheet, DialogueLog, InputLine, Inventory, MapPanel, QuestLog } from "./panels.js";

/** Wide enough for a map three places across. */
const SIDEBAR_WIDTH = 36;

interface AppProps {
  session: SessionController;
  initial: LogLine[];
  voice: VoiceOver;
  /** Plays the mood music of wherever the player is. */
  music: MusicPlayer;
  /** Read `initial` aloud: a new game's intro is, a resumed one's history isn't. */
  readAloud: boolean;
  /** Back to the start menu (/new). */
  onMenu: () => void;
}

/** A game in progress, or a character being made for one (before there's a game, without the sidebar). */
export function App({ session, initial, voice, music, readAloud, onMenu }: AppProps) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [log, setLog] = useState<LogLine[]>(initial);
  const [input, setInput] = useState<LineState>(EMPTY_LINE);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(() => gameView(session));
  // Each row of places on the map takes six lines; show more of it on taller terminals.
  const mapRows = rows >= 46 ? 3 : rows >= 38 ? 2 : 1;

  useEffect(() => {
    voice.onNotice = (text) => setLog((log) => [...log, { kind: "system", text }]);
    if (readAloud) voice.say(initial);
    music.play(session.music);
  }, []);

  async function submit(text: string) {
    setLog((lines) => [...lines, { kind: "player", text }]);
    setBusy(true);
    voice.stop();
    const result = await session.submit(text);
    if (result.quit) {
      exit();
      return;
    }
    if (result.menu) {
      onMenu();
      return;
    }
    const lines: LogLine[] = result.voice
      ? [{ kind: "system", text: `Reading aloud is ${voice.setEnabled(result.voice.on ?? !voice.enabled) ? "on" : "off"}.` }]
      : result.music
        ? [{ kind: "system", text: `Music is ${music.setEnabled(result.music.on ?? !music.enabled) ? "on" : "off"}.` }]
        : result.lines;
    music.play(session.music);
    voice.say(lines);
    setLog((log) => (result.reset ? lines : [...log, ...lines]).slice(-200));
    setView(gameView(session));
    setBusy(false);
  }

  useInput((char, key) => {
    if (key.escape) {
      exit();
      return;
    }
    if (key.tab) {
      voice.stop();
      return;
    }
    if (busy) return;
    // Keys typed while the app was busy can arrive in one chunk; an Enter at the end of it still submits.
    const enter = key.return || (/[\r\n]$/.test(char) && !key.ctrl && !key.meta);
    if (enter) {
      const text = (key.return ? input : editLine(input, char.replace(/[\r\n]+$/, ""), key)).text.trim();
      setInput(EMPTY_LINE);
      if (text) void submit(text);
      return;
    }
    setInput((line) => editLine(line, char, key));
  });

  return (
    <Box flexDirection="column" height={Math.max(rows - 1, 16)}>
      <Box flexGrow={1}>
        <DialogueLog title={`${session.title} · ${view ? view.scene.location.name : "A new character"}`} lines={log} busy={busy} />
        {view && (
          <Box flexDirection="column" width={SIDEBAR_WIDTH} flexShrink={0}>
            <MapPanel map={view.map} width={SIDEBAR_WIDTH} rows={mapRows} />
            <CharacterSheet character={view.scene.character} status={view.status} />
            <Inventory items={view.scene.character.inventory} />
            <QuestLog quests={view.scene.quests} />
          </Box>
        )}
      </Box>
      <InputLine line={input} busy={busy} />
    </Box>
  );
}

/** What the sidebar shows, once there's a game. */
function gameView(session: SessionController) {
  return session.playing ? { scene: session.scene, map: session.map, status: session.status } : undefined;
}
