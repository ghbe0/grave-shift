# Grave Shift

A browser movement shooter: thrust jumps, wall-running and slide-cancels, a ten-point loadout
system, and round-based co-op survival against the undead. Runs entirely as static files on
GitHub Pages. Multiplayer is peer-to-peer over WebRTC, so there is no game server to host.

**Play:** https://ghbe0.github.io/grave-shift/

## Playing together

1. Enter a name and press **Host a party**. You get a 6-character code like `K7QF2M` and an
   invite link like `https://ghbe0.github.io/grave-shift/?party=K7QF2M`.
2. Friends open the link (or type the code and press **Join**).
3. The host picks the mode and map, and can kick or ban players. Guests press **Ready**.
4. The host presses **Start match**. People who join mid-match drop straight in.

The host's browser runs the authoritative simulation. Guests predict their own movement and
shooting locally and interpolate everything else. The public PeerJS broker only introduces the
browsers to each other; game traffic then flows directly between them. If the host closes the
tab, the party ends.

| Mode | Players | |
| --- | --- | --- |
| Survival | 1-4 | Co-op rounds. Buy doors, weapons, perks; finish the map's quests. |
| Skirmish | 2-8 | Free-for-all with your ten-point loadout, abilities and streaks. First to 25. |

## Controls

WASD move · Shift sprint · C or Ctrl crouch / slide · Space jump (hold in the air to thrust) ·
run into a wall while airborne to wall-run · Left mouse fire · Right mouse aim · R reload ·
1/2, X or wheel switch weapon · V melee · G lethal · E tactical · Q ability · F use / buy /
revive (hold) · Z tonic · 4/5/6 streaks · Tab scores · Esc pause

## How it is built

```
.
├── Cargo.toml                    Rust workspace
├── crates/sim/src/               Simulation core, compiled to WebAssembly (no dependencies)
│   ├── lib.rs                    C ABI exported to JavaScript (gs_* functions)
│   ├── math.rs                   Vectors, AABBs, ray tests
│   ├── world.rs                  Collision world, move-and-slide, wall/ledge probes, nav grid + flow field
│   ├── controller.rs             Character controller: thrust meter, wall-run, slide/cancel, mantle, camera feel
│   ├── arms.rs                   Weapon state machine, ADS, deterministic recoil patterns and spread
│   ├── catalog.rs                Weapons, attachments, perks, abilities, streaks, tonics
│   ├── loadout.rs                Ten-point loadout rules and wildcards
│   ├── maps.rs                   ASCII map blueprints, zones, doors, parts and quest step scripts
│   ├── game.rs                   Match state, lag-compensated hitscan, damage, abilities, snapshots
│   ├── survival.rs               Rounds, health scaling, horde cap, zombie AI, economy, quests
│   └── util.rs                   Flat f32 serialisation and the layout table shared with TypeScript
├── src/
│   ├── main.ts                   App: menus, party flow, frame loop
│   ├── core/sim.ts               Typed bindings over the Wasm ABI
│   ├── engine/input.ts           Pointer Lock mouse look and key bindings
│   ├── engine/ticker.ts          Worker clock so the match keeps running in a hidden tab
│   ├── game/session.ts           Solo / host / guest match driver
│   ├── game/scene.ts             Builds each rendered frame from match state
│   ├── gfx/renderer.ts           Backend-neutral renderer interface; WebGPU with WebGL2 fallback
│   ├── gfx/webgpu.ts             Shadow pass, HDR PBR pass, bloom chain, composite
│   ├── gfx/webgl2.ts             Fallback: same PBR lighting and shadows, no post-processing
│   ├── gfx/shaders/scene.wgsl    GGX PBR, PCF sun shadows, point/spot lights, fog
│   ├── gfx/shaders/post.wgsl     Bloom, camera motion blur, depth of field, ACES tone map
│   ├── gfx/loader.ts             glTF 2.0 / .glb loader with embedded textures
│   ├── gfx/mat.ts                Matrix maths
│   ├── netcode/party.ts          6-character codes and ?party=CODE links
│   ├── netcode/transport.ts      PeerJS WebRTC transport, plus a same-browser test transport
│   ├── netcode/lobby.ts          Host-owned lobby: map/mode, start, kick, ban, late join
│   ├── netcode/predict.ts        Client-side prediction and reconciliation
│   ├── netcode/interp.ts         Snapshot interpolation
│   ├── audio/sfx.ts              Procedural Web Audio sound effects
│   └── ui/                       HUD, loadout editor, styles
├── public/assets/                .glb models (weapons, props), loaded at runtime
├── tools/build-wasm.mjs          cargo build --target wasm32-unknown-unknown, copies the module
├── tools/gen-assets.mjs          Generates the placeholder .glb models
├── tests/                        Vitest: Wasm bindings, netcode, glTF loader
└── .github/workflows/deploy.yml  Build, test and publish to GitHub Pages
```

Everything that decides an outcome lives in Rust: movement, weapons, hit detection, damage,
zombie AI, the economy and quests. The host and every guest run the same Wasm module, which is
what makes prediction line up with the host's results. TypeScript reads struct fields through a
layout table the module generates (`gs_layout`), so there is no second copy of any struct.

### Survival numbers

- Zombie health: `150 + 100 × (round − 1)` through round 9, then `950 × 1.1^(round − 9)`.
- At most 24 zombies alive at once solo (+6 per extra player, up to 42); the rest wait in the spawn queue.
- Points: +10 per hit, +60 per kill, +100 per headshot kill, +130 per melee kill.
- Four perks at most. Downs clear your perks.
- Barricades lose a board every 1.1 s while a zombie tears at them; rebuild with F.

### Netcode

- Guests send one 9-float command per 60 Hz tick (unreliable, unordered channel).
- The host simulates them in order, limited by a time bank so a client cannot run faster than real time.
- Snapshots go out at 20 Hz with the events since the last one.
- Guests rewind their player to the host's state and replay unacknowledged commands; remote
  players and zombies are drawn 100 ms in the past, blended between snapshots.
- Shots are checked against where targets were on the shooter's screen, up to 400 ms back.

### Assets

The models in `public/assets` are generated placeholders. Drop in a `.glb` with the same name to
replace one; the loader bakes node transforms and reads PBR factors and base-colour textures.
Skinning and animation are not supported yet.

## Development

Requires Rust (with `rustup target add wasm32-unknown-unknown`) and Node 20+.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

Debug switches in the URL: `?renderer=webgl2` forces the fallback, `?low` lowers shadow resolution
and disables post-processing, and `?net=local` swaps WebRTC for a same-browser channel, so two tabs
can test a party without the internet. `?offscreen` renders WebGPU into a texture for automated tests.

## Deploying

Push to `main`. The workflow builds and publishes `dist/`. In the repository settings, set
**Pages → Build and deployment → Source** to **GitHub Actions** once.
