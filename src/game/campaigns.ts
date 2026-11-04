import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/provider.js";
import { NarrativeEngine } from "../narrative/engine.js";
import type { CampaignStore, SaveSummary } from "../storage/store.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld, parseMarkdown } from "../world/loader.js";
import { SessionController } from "./session.js";

/** A campaign in the content directory: a folder with a world.md. Its id is the folder's name, and its save's. */
export interface CampaignInfo {
  id: string;
  title: string;
  /** One line for the menu (`tagline` in world.md). */
  tagline?: string;
  dir: string;
}

/** Saves from before there was a choice of campaign were all of The Hollow Lantern, under this id. */
export const LEGACY_SAVE = { id: "default", campaign: "hollow-lantern" };

/** Every campaign under `contentDir`, by title. */
export async function listCampaigns(contentDir: string): Promise<CampaignInfo[]> {
  const entries = await readdir(contentDir, { withFileTypes: true });
  const campaigns = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e): Promise<CampaignInfo | undefined> => {
        const dir = path.join(contentDir, e.name);
        const text = await readFile(path.join(dir, "world.md"), "utf8").catch(() => undefined);
        if (text === undefined) return undefined;
        const { title, tagline } = parseMarkdown(text).data;
        return {
          id: e.name,
          title: typeof title === "string" ? title : e.name,
          ...(typeof tagline === "string" && { tagline }),
          dir,
        };
      }),
  );
  return campaigns.filter((c) => c !== undefined).sort((a, b) => a.title.localeCompare(b.title));
}

/** One campaign, ready to play. */
export interface OpenCampaign {
  info: CampaignInfo;
  world: WorldEngine;
  session: SessionController;
}

/**
 * The campaigns on offer and their saved games. A campaign is loaded the first time it's opened, and kept:
 * going back to the menu and choosing it again carries on with the same session.
 */
export class CampaignLibrary {
  private readonly open = new Map<string, OpenCampaign>();

  constructor(
    readonly campaigns: CampaignInfo[],
    private readonly store: CampaignStore,
    private readonly llm: LlmProvider,
  ) {}

  static async load(contentDir: string, store: CampaignStore, llm: LlmProvider): Promise<CampaignLibrary> {
    const campaigns = await listCampaigns(contentDir);
    if (!campaigns.length) throw new Error(`No campaigns in ${contentDir}: each needs a folder with a world.md`);
    if (campaigns.some((c) => c.id === LEGACY_SAVE.campaign)) await store.rename(LEGACY_SAVE.id, LEGACY_SAVE.campaign);
    return new CampaignLibrary(campaigns, store, llm);
  }

  /** Saved games of campaigns that are still here, most recently played first. */
  async saves(): Promise<SaveSummary[]> {
    return (await this.store.saves()).filter((s) => this.campaigns.some((c) => c.id === s.campaignId));
  }

  async get(id: string): Promise<OpenCampaign> {
    const already = this.open.get(id);
    if (already) return already;
    const info = this.campaigns.find((c) => c.id === id);
    if (!info) throw new Error(`No campaign "${id}"`);
    const world = new WorldEngine(await loadWorld(info.dir));
    const session = new SessionController({
      world,
      narrative: new NarrativeEngine(this.llm, world.world.rules),
      store: this.store,
      campaignId: info.id,
    });
    const opened = { info, world, session };
    this.open.set(id, opened);
    return opened;
  }
}
