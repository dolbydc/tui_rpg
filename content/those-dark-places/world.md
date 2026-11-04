---
title: Those Dark Places
# One line for the start menu.
tagline: Deep Bore 4 broke into something. The Combine sealed the crew in. You're here to sign off the loss.
start: dock-three
# Station time. Night cycle: the corridor lights are dimmed to save on the power bill.
start_time: "23:10"
# Kokoro text-to-speech voice for narration (see README for the list).
narrator_voice: am_onyx
character:
  name: Rook
  pronouns: they/them
  hp: 10
  stats:
    might: 3
    wits: 3
    grace: 2
    charisma: 2
  inventory:
    - contractor's badge
    - hand torch
    - 3 scrip chits
quests:
  - id: the-claim
    title: The Claim
    description: Your contract with the Aurex Combine is simple. Certify the Deep Bore 4 crew as lost, so the policy pays out. The foreman, Ines Varga, says the Combine already knows exactly what happened down there. Find the proof and put it in her hands.
    # Done when every condition holds (checked after each action). Conditions:
    #   have: <item>   gave: {item: <item>, to: <npc>}   at: <location>   visited: <location>   knows: <npc>
    #   completed: <quest>
    done:
      - gave: { item: incident report, to: ines }
    reward:
      xp: 50
  - id: survivor
    title: Survivor
    description: Somebody on the Bore 4 crew is still alive. The dead comms line still clicks, three short and three long. Get down there before their air runs out, and give them some of yours.
    done:
      - knows: teo
      - gave: { item: oxygen canister, to: teo }
    reward:
      xp: 100
      items:
        - 20 scrip chits
  - id: payroll
    title: Names on the Payroll
    description: Everyone on Tithe Nine is a number on somebody's ledger. Find out who the people that matter really are.
    done:
      - knows: ines
      - knows: hask
      - knows: sallow
    reward:
      xp: 25
  - id: what-the-bore-found
    title: What the Bore Found
    description: Teo says the drill didn't hit rock at the bottom of Bore 4. It hit something hollow, and something inside it is humming. Find it.
    starts:
      - completed: survivor
    done:
      - have: black seed
    reward:
      xp: 75
---
The Combine shuttle docks with a shudder and a hiss of cheap seals. Through the scratched port, Tithe Nine hangs off the face of a dead grey moon: a rust-streaked tangle of habitation rings and drill towers, bolted into the rock and lit sodium orange. Your contract fits on a single line. Certify the loss of the Deep Bore 4 crew so the policy pays out. Eleven names. A signature. The ship back leaves in three days.
