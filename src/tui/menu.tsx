import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { CampaignInfo } from "../game/campaigns.js";
import type { SaveSummary } from "../storage/store.js";

/** What a menu entry does. */
export type MenuChoice = { kind: "continue"; campaignId: string } | { kind: "new"; campaignId: string } | { kind: "quit" };

export interface MenuItem {
  section: "Continue" | "New game" | "";
  label: string;
  /** Shown dimmed after the label. */
  detail?: string;
  choice: MenuChoice;
}

/** Saved games first, most recent first; then a new game of each campaign; then quit. */
export function menuItems(campaigns: CampaignInfo[], saves: SaveSummary[], now = new Date()): MenuItem[] {
  const title = (id: string) => campaigns.find((c) => c.id === id)?.title ?? id;
  return [
    ...saves.map(
      (save): MenuItem => ({
        section: "Continue",
        label: title(save.campaignId),
        detail: `${save.characterName}, turn ${save.turn}, ${ago(save.updatedAt, now)}`,
        choice: { kind: "continue", campaignId: save.campaignId },
      }),
    ),
    ...campaigns.map(
      (campaign): MenuItem => ({
        section: "New game",
        label: campaign.title,
        detail: [campaign.tagline, saves.some((s) => s.campaignId === campaign.id) ? "replaces your saved game" : undefined]
          .filter(Boolean)
          .join(" · "),
        choice: { kind: "new", campaignId: campaign.id },
      }),
    ),
    { section: "", label: "Quit", choice: { kind: "quit" } },
  ];
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (!(minutes >= 1)) return "just now";
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 60 * 24 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

interface StartMenuProps {
  items: MenuItem[];
  onChoose: (choice: MenuChoice) => void;
  /** A problem to show above the menu (a campaign that failed to load, say). */
  notice?: string;
}

/** The first screen: pick a saved game to carry on, or a campaign to start. ↑↓ or a number, then Enter. */
export function StartMenu({ items, onChoose, notice }: StartMenuProps) {
  const [selected, setSelected] = useState(0);

  useInput((char, key) => {
    if (key.escape) return onChoose({ kind: "quit" });
    if (key.upArrow) return setSelected((i) => (i + items.length - 1) % items.length);
    if (key.downArrow) return setSelected((i) => (i + 1) % items.length);
    if (key.return) return onChoose(items[selected].choice);
    // A number only selects: if it chose too, the same keypress could land in the game's input line.
    const n = Number(char);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) setSelected(n - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        TUI RPG
      </Text>
      {notice && <Text color="red">{notice}</Text>}
      {items.map((item, i) => (
        <Box key={i} flexDirection="column">
          {item.section !== (items[i - 1]?.section ?? "none") && (
            <Box marginTop={1}>
              <Text bold>{item.section}</Text>
            </Box>
          )}
          <Text>
            <Text color={i === selected ? "yellow" : undefined}>
              {i === selected ? "› " : "  "}
              {i + 1}. {item.label}
            </Text>
            {item.detail && <Text dimColor> · {item.detail}</Text>}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>↑↓ or a number to choose · Enter to start · Esc to quit</Text>
      </Box>
    </Box>
  );
}
