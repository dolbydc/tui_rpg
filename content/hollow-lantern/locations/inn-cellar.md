---
name: Hollow Lantern Inn's Cellar
label: Cellar
exits:
  up: hollow-lantern-inn
items:
  # A counted pile: "take a crate" takes one, "take the crates" the lot.
  - 6 crates
# Not seen until the player searches. Where it's hidden and what they notice are told to the narrator
# only when it's found, so they don't belong in the description below.
hidden_items:
  - item: ledger book
    hidden: fallen behind a few of the crates
    found: it is mostly just inventory in and out, but someone has written some notes in it about "letting the forest return and take over".
---
A dimly lite hole dug into the ground below the inn, down some uneven half rotted wooden step is a dirt floor with a dozen crates stacked around. There are a couple of lit touches on the walls.