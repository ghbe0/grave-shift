// Modes and the match settings a host can change in the party lobby. The simulation clamps rules
// again on its side (`modes.rs`); here every setting is limited to the choices the menu offers,
// so a guest only ever sees, and plays with, values the host could have picked.

export interface ModeInfo { id: number; name: string; max: number; teams: boolean; desc: string }

export const MODES: ModeInfo[] = [
  { id: 0, name: 'Survival', max: 4, teams: false, desc: 'Co-op against endless rounds of the undead' },
  { id: 1, name: 'Free-for-All', max: 8, teams: false, desc: 'Every player for themselves: most kills wins' },
  { id: 2, name: 'Team Deathmatch', max: 12, teams: true, desc: 'Two teams; every kill scores for your side' },
  { id: 3, name: 'Domination', max: 12, teams: true, desc: 'Take and hold zones A, B and C; held zones score over time' },
  { id: 4, name: 'King of the Hill', max: 12, teams: true, desc: 'Stand on the hill with no enemies on it to score; it moves every minute' },
  { id: 5, name: 'Tag Hunt', max: 12, teams: true, desc: 'Kills drop tags: grab enemy tags to score, grab your own to deny them' },
  { id: 6, name: 'Weapon Ladder', max: 8, teams: false, desc: 'Each kill hands you the next weapon; first to finish all 20 wins' },
];
export const LADDER_RUNGS = 20;

export const TEAM_NAMES = ['Crimson', 'Cobalt'];
export const TEAM_COLORS: [number, number, number][] = [[0.86, 0.16, 0.2], [0.18, 0.48, 1.0]];
export const TEAM_CSS = ['#e0323c', '#3d8bff'];

export interface Rules {
  /** Seconds, 0 for no limit. */
  timeLimit: number;
  /** 0 for no limit. */
  scoreLimit: number;
  respawn: number;
  health: number;
  friendlyFire: boolean;
  headshotsOnly: boolean;
  abilities: boolean;
  streaks: boolean;
  startRound: number;
  startPoints: number;
}
/** Order of the numbers handed to the simulation (`Rules::from_floats`). */
const ORDER: (keyof Rules)[] = ['timeLimit', 'scoreLimit', 'respawn', 'health', 'friendlyFire', 'headshotsOnly', 'abilities', 'streaks', 'startRound', 'startPoints'];

const DEFAULT_LIMITS: [number, number][] = [[0, 0], [480, 25], [600, 75], [600, 200], [600, 150], [600, 65], [600, LADDER_RUNGS]];

export function defaultRules(mode: number): Rules {
  const [timeLimit, scoreLimit] = DEFAULT_LIMITS[mode] ?? DEFAULT_LIMITS[1];
  return { timeLimit, scoreLimit, respawn: 3, health: 1, friendlyFire: false, headshotsOnly: false, abilities: true, streaks: true, startRound: 1, startPoints: 500 };
}

export type Choice = [number, string];
const mins = (m: number): Choice => [m * 60, `${m} minutes`];
export const TIME_CHOICES: Choice[] = [[0, 'No limit'], mins(3), mins(5), mins(8), mins(10), mins(15), mins(20), mins(30)];
const SCORE_CHOICES: number[][] = [
  [],
  [10, 15, 20, 25, 30, 40, 50, 0],
  [25, 50, 75, 100, 150, 0],
  [100, 150, 200, 250, 300, 0],
  [60, 100, 150, 200, 250, 0],
  [30, 50, 65, 75, 100, 0],
  [LADDER_RUNGS],
];
export function scoreChoices(mode: number): Choice[] {
  const unit = mode === 1 ? 'kills' : mode === 2 ? 'kills' : mode === 5 ? 'tags' : mode === 6 ? 'rungs' : 'points';
  return (SCORE_CHOICES[mode] ?? []).map(v => [v, v ? `${v} ${unit}` : 'No limit']);
}
export const RESPAWN_CHOICES: Choice[] = [[0, 'Instant'], [1.5, '1.5 seconds'], [3, '3 seconds'], [5, '5 seconds'], [8, '8 seconds'], [10, '10 seconds']];
export const HEALTH_CHOICES: Choice[] = [[0.5, '50%'], [1, '100%'], [1.5, '150%'], [2, '200%'], [3, '300%']];
export const ROUND_CHOICES: Choice[] = [1, 5, 10, 15, 20, 25, 30, 40, 50].map(r => [r, `Round ${r}`]);
export const POINTS_CHOICES: Choice[] = [500, 1000, 2500, 5000, 10000, 25000, 50000].map(p => [p, p.toLocaleString('en-US')]);

/** Rules from anything (a lobby message, saved data): each field must be one of the menu's choices. */
export function cleanRules(raw: unknown, mode: number): Rules {
  const def = defaultRules(mode);
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const pick = (v: unknown, choices: Choice[], fallback: number) => (choices.some(c => c[0] === v) ? (v as number) : fallback);
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    timeLimit: mode === 0 ? 0 : pick(r.timeLimit, TIME_CHOICES, def.timeLimit),
    scoreLimit: pick(r.scoreLimit, scoreChoices(mode), def.scoreLimit),
    respawn: pick(r.respawn, RESPAWN_CHOICES, def.respawn),
    health: pick(r.health, HEALTH_CHOICES, def.health),
    friendlyFire: flag(r.friendlyFire, def.friendlyFire),
    headshotsOnly: flag(r.headshotsOnly, def.headshotsOnly),
    abilities: flag(r.abilities, def.abilities),
    streaks: flag(r.streaks, def.streaks),
    startRound: pick(r.startRound, ROUND_CHOICES, def.startRound),
    startPoints: pick(r.startPoints, POINTS_CHOICES, def.startPoints),
  };
}

export function rulesToFloats(r: Rules): number[] {
  return ORDER.map(k => (typeof r[k] === 'boolean' ? (r[k] ? 1 : 0) : (r[k] as number)));
}

/** One line for the lobby: what is different from the mode's defaults. */
export function rulesSummary(r: Rules, mode: number): string {
  const def = defaultRules(mode);
  const label = (choices: Choice[], v: number) => choices.find(c => c[0] === v)?.[1] ?? String(v);
  const out: string[] = [];
  if (mode !== 0) {
    out.push(label(TIME_CHOICES, r.timeLimit) === 'No limit' ? 'no time limit' : label(TIME_CHOICES, r.timeLimit));
    if (mode !== 6) out.push(r.scoreLimit ? label(scoreChoices(mode), r.scoreLimit) : 'no score limit');
  } else {
    if (r.startRound !== def.startRound) out.push(`start on round ${r.startRound}`);
    if (r.startPoints !== def.startPoints) out.push(`${label(POINTS_CHOICES, r.startPoints)} starting points`);
  }
  if (r.health !== def.health) out.push(`${label(HEALTH_CHOICES, r.health)} health`);
  if (mode !== 0 && r.respawn !== def.respawn) out.push(`respawn ${label(RESPAWN_CHOICES, r.respawn).toLowerCase()}`);
  if (r.friendlyFire) out.push('friendly fire');
  if (r.headshotsOnly) out.push('headshots only');
  if (!r.abilities) out.push('no abilities');
  if (!r.streaks && mode !== 0) out.push('no streaks');
  return out.join(' · ');
}
