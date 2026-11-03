import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { GameState, NpcMemory, TurnRecord } from "../domain/types.js";
import type { CampaignStore, SavedCampaign } from "./store.js";

// JSON is stored as text, timestamps as ISO 8601 text, and `seq` (insertion order) is the integer primary
// key, so it numbers itself.
const SCHEMA = `
create table if not exists campaigns (
  id         text primary key,
  state      text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create table if not exists turns (
  seq         integer primary key autoincrement,
  campaign_id text not null references campaigns(id) on delete cascade,
  turn        integer not null,
  record      text not null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists turns_by_campaign on turns (campaign_id, seq);
create table if not exists npc_memories (
  seq         integer primary key autoincrement,
  id          text not null unique,
  campaign_id text not null references campaigns(id) on delete cascade,
  npc_id      text not null,
  turn        integer not null,
  memory      text not null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists npc_memories_by_npc on npc_memories (campaign_id, npc_id, turn);`;

/** A campaign store in a single SQLite file. */
export class SqliteStore implements CampaignStore {
  readonly db: Database.Database;

  /** `file` is created (with its directory) if it doesn't exist; ":memory:" keeps nothing. */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    // Rollback journal rather than WAL: WAL needs shared memory, which a Windows drive under WSL
    // (/mnt/c) doesn't reliably support. One player, one process: the difference doesn't matter.
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  async load(campaignId: string, recentTurns = 10): Promise<SavedCampaign | undefined> {
    const campaign = this.db.prepare<[string], { state: string }>("select state from campaigns where id = ?").get(campaignId);
    if (!campaign) return undefined;
    const turns = this.db
      .prepare<[string, number], { record: string }>(
        "select record from turns where campaign_id = ? order by seq desc limit ?",
      )
      .all(campaignId, recentTurns);
    // Insertion order, so memories replay in the order they were formed.
    const memories = this.db
      .prepare<[string], { memory: string }>("select memory from npc_memories where campaign_id = ? order by seq")
      .all(campaignId);
    return {
      state: JSON.parse(campaign.state) as GameState,
      recent: turns.map((r) => JSON.parse(r.record) as TurnRecord).reverse(),
      memories: memories.map((r) => JSON.parse(r.memory) as NpcMemory),
    };
  }

  async commitTurn(state: GameState, record: TurnRecord, memories: NpcMemory[] = []): Promise<void> {
    const insertMemory = this.db.prepare(
      "insert into npc_memories (id, campaign_id, npc_id, turn, memory) values (?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      // An upsert, not "insert or replace": replacing would delete the row, and with it (cascading) the history.
      this.db
        .prepare(
          `insert into campaigns (id, state) values (?, ?)
           on conflict (id) do update set state = excluded.state,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(state.campaignId, JSON.stringify(state));
      this.db
        .prepare("insert into turns (campaign_id, turn, record) values (?, ?, ?)")
        .run(state.campaignId, record.turn, JSON.stringify(record));
      for (const memory of memories) {
        insertMemory.run(memory.id, state.campaignId, memory.npcId, memory.turn, JSON.stringify(memory));
      }
    })();
  }

  async reset(campaignId: string): Promise<void> {
    this.db.prepare("delete from campaigns where id = ?").run(campaignId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
