// The minds window's page: the game's minds, from the same views and activity the game's window gets.
import { replayActivity, setUpMindsWindow, showActivity, updateMinds } from "./minds.js";

const rpg = window.rpg;
rpg.onView((view) => updateMinds(view.player?.minds));
// What happened before it opened comes first, then each thing as it happens.
rpg.onHistory(replayActivity);
rpg.onActivity(showActivity);
setUpMindsWindow();
rpg.mindsReady();
