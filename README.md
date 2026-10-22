# Grave Shift

Round-based zombie survival in the browser. Solo, or co-op with up to 4 friends.

**Play:** https://ghbe0.github.io/grave-shift/

## Playing with friends

1. Open the site, enter a name, press **Host game**.
2. Press **Esc**, then **Copy** the invite link and send it to your friends.
3. They open the link, enter a name and press **Join**.

The host's browser runs the game, and friends connect straight to it over WebRTC (PeerJS's free public broker only introduces you). No accounts and no server to pay for. If the host closes the tab, the game ends.

## Controls

WASD move · Shift sprint · C crouch/slide · Space jump · Left mouse shoot · Right mouse aim · R reload · 1/2/wheel switch · V melee · G grenade (hold to cook) · F buy/revive · Esc pause/invite

Power-ups drop from zombies: Max Ammo, Insta-Kill, Double Points and Nuke. Walk over them before they blink out.

## Development

No build step. Serve the folder and open it:

```bash
python -m http.server 8080
```

Tests (Node 20+): `node --test`

- `rules.js`: map, weapons, perks, round formulas, pathfinding (pure, shared)
- `sim.js`: authoritative game state, run by the host
- `net.js`: PeerJS host/join
- `game.js`: rendering, input, HUD, audio
