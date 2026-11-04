---
title: The Hollow Lantern
start: village-square
# The intro is set at night: "Tonight it finally lets up".
start_time: "20:00"
# Kokoro text-to-speech voice for narration (see README for the list).
narrator_voice: bm_george
character:
  name: Wren
  pronouns: he/him
  hp: 10
  stats:
    might: 2
    wits: 3
    grace: 2
    charisma: 3
  inventory:
    - traveler's cloak
    - 3 copper coins
quests:
  - id: missing-lantern
    title: The Missing Lantern
    description: The lantern that hung in an iron cage above the inn door for a hundred years has vanished. Find out who took it.
    # Done when every condition holds (checked after each action). Conditions:
    #   have: <item>   gave: {item: <item>, to: <npc>}   at: <location>   visited: <location>   knows: <npc>
    done:
      - visited: forest-depths-1
      - gave: { item: lantern-key, to: marta }
    reward:
      xp: 100
      items:
        - 5 silver pennies
  - id: introductions
    title: Faces of Brackenford
    description: Strangers get nowhere in a village like this. Learn the names of the people who matter.
    done:
      - knows: marta
      - knows: old-pell
    reward:
      xp: 25
---
Rain has followed you for three days down the old drover's road. Tonight it finally lets up as you reach Brackenford, a huddle of slate roofs at the edge of the Thornwood. Above the inn door hangs an empty iron hook where, everyone says, a lantern has burned for a hundred years.
