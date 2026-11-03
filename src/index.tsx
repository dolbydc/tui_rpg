#!/usr/bin/env node
// Composition root: the only place that picks concrete implementations.
import { render } from "ink";
import { loadConfig, type Config } from "./config.js";
import { SessionController } from "./game/session.js";
import { MockProvider } from "./llm/mock.js";
import { OllamaProvider } from "./llm/ollama.js";
import type { LlmProvider } from "./llm/provider.js";
import { NarrativeEngine } from "./narrative/engine.js";
import { InMemoryStore } from "./storage/memory.js";
import { SqliteStore } from "./storage/sqlite.js";
import type { CampaignStore } from "./storage/store.js";
import { App } from "./tui/app.js";
import { KokoroSpeaker } from "./voice/kokoro.js";
import { systemPlayer } from "./voice/players.js";
import { VoiceOver } from "./voice/voice-over.js";
import { WorldEngine } from "./world/engine.js";
import { loadWorld } from "./world/loader.js";

function createProvider(config: Config): LlmProvider {
  return config.llm === "mock"
    ? new MockProvider()
    : new OllamaProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel });
}

function createStore(config: Config): CampaignStore {
  return config.storage === "memory" ? new InMemoryStore() : new SqliteStore(config.sqliteFile);
}

async function main() {
  const config = loadConfig();
  const world = new WorldEngine(await loadWorld(config.campaignDir));
  const store = createStore(config);
  const llm = createProvider(config);
  // Load the model in the background while the player reads the intro; errors surface on the first turn.
  void llm.warmUp?.().catch(() => {});
  const session = new SessionController({
    world,
    narrative: new NarrativeEngine(llm, world.world.rules),
    store,
    campaignId: config.campaignId,
  });

  // Reading aloud: the speech model loads in the background too (or on /voice on, if it starts off). If it
  // can't work, the player is told once and it goes quiet.
  const speaker = new KokoroSpeaker({
    onError: (err) => voice.report(`Reading aloud is off: ${err.message}`),
    player: systemPlayer(process.platform, config.player),
  });
  const voice = new VoiceOver(speaker, world.world, config.voice === "on");
  if (config.voice === "on") void speaker.warmUp().catch(() => {});

  const initial = await session.start();
  const app = render(<App session={session} initial={initial} voice={voice} />);
  await app.waitUntilExit();
  await speaker.close();
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
