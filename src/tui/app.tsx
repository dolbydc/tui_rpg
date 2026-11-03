import { useEffect, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import type { LogLine } from "../domain/types.js";
import type { SessionController } from "../game/session.js";
import type { VoiceOver } from "../voice/voice-over.js";
import { EMPTY_LINE, editLine, type LineState } from "./line-editor.js";
import { CharacterSheet, DialogueLog, InputLine, Inventory, MapPanel, QuestLog } from "./panels.js";

/** Wide enough for a map three places across. */
const SIDEBAR_WIDTH = 36;

interface AppProps {
  session: SessionController;
  initial: LogLine[];
  voice: VoiceOver;
}

export function App({ session, initial, voice }: AppProps) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [log, setLog] = useState<LogLine[]>(initial);
  const [input, setInput] = useState<LineState>(EMPTY_LINE);
  const [busy, setBusy] = useState(false);
  const [scene, setScene] = useState(() => session.scene);
  const [map, setMap] = useState(() => session.map);
  const [status, setStatus] = useState(() => session.status);
  // Each row of places on the map takes six lines; show more of it on taller terminals.
  const mapRows = rows >= 46 ? 3 : rows >= 38 ? 2 : 1;

  // A new game's intro is read out; a resumed one's history isn't.
  useEffect(() => {
    voice.onNotice = (text) => setLog((log) => [...log, { kind: "system", text }]);
    if (!session.resumed) voice.say(initial);
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
    const lines: LogLine[] = result.voice
      ? [{ kind: "system", text: `Reading aloud is ${voice.setEnabled(result.voice.on ?? !voice.enabled) ? "on" : "off"}.` }]
      : result.lines;
    voice.say(lines);
    setLog((log) => (result.reset ? lines : [...log, ...lines]).slice(-200));
    setScene(session.scene);
    setMap(session.map);
    setStatus(session.status);
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
        <DialogueLog title={`${session.title} · ${scene.location.name}`} lines={log} busy={busy} />
        <Box flexDirection="column" width={SIDEBAR_WIDTH} flexShrink={0}>
          <MapPanel map={map} width={SIDEBAR_WIDTH} rows={mapRows} />
          <CharacterSheet character={scene.character} status={status} />
          <Inventory items={scene.character.inventory} />
          <QuestLog quests={scene.quests} />
        </Box>
      </Box>
      <InputLine line={input} busy={busy} />
    </Box>
  );
}
