// Token Radar's scoring model, radar-2. A sealed snapshot goes in, a ranked board comes out.
//
// The board starts from the snapshot's watchlist — the floor, not a ceiling — and adds the
// early pre-token protocols below that floor, the rows this radar exists to surface. A protocol
// counts as pre-token when its entry records no token at all: no market cap, no CoinGecko id,
// no symbol. The live-token protocols are kept apart and shown at the market's own values, never
// folded into the ranking.
//
// Implied value is computed only from the snapshot's own figures. TVL sets the scale, the
// seven-day change orders rows inside that scale, and the time a protocol has run with no token
// decides how much of the scale counts:
//
//   base       = tvl_usd x BASE_MULTIPLE
//   growth     = clamp(change_7d, -80, 200) per cent; a null change counts as 0 with a 0.95 discount
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.55 + min(age_days, 1460) / 1460 x 0.65   (age_days unknown: 180)
//   implied    = max(1, round(base x growthMult x maturity x discount))
//
// Why these numbers, and why they are not a plain TVL ranking:
// - Growth weighs 0.9, not 0.5: a protocol whose TVL compounds week on week is worth more per
//   dollar locked than one bleeding TVL, and the snapshot's own growth range (-72% to +4448%)
//   needs a clamp wide enough to separate a real +160% week from a +30% week without letting one
//   data spike (+4448%) buy the top of the board. The clamp at +200% does that.
// - Maturity runs 0.55 to 1.20 over four years, not 0.6 to 1.0 over three: surviving four years
//   with no token is a longer proof of a business that can launch one, and a protocol that only
//   just appeared has not earned the same credit.
// - An unknown listing date uses 180 days, not a full year: the snapshot cannot prove a long
//   no-token runway for it, so the model does not credit one. 113 of the 758 protocols have no
//   listed_at, so this is not a corner case.
// - A missing seven-day change is discounted 5%: the model cannot see momentum, so it pays less
//   for the row. Only 4 protocols are missing it.
//
// The constants are the house model's successor, stated in the dashboard and changeable in the
// model sandbox. No protocol name is ever special-cased: one function scores every row.

/** One protocol entry from the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document as the kit hands it over. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  missing_growth_discount: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.3,
  growth_weight: 0.9,
  growth_floor: -80,
  growth_cap: 200,
  maturity_floor: 0.55,
  maturity_range: 0.65,
  maturity_days: 1460,
  unknown_age_days: 180,
  missing_growth_discount: 0.95,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 220;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    data_discount: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  data_discount: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, else `fallback`. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, never below zero; null when either date is absent or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / MS_PER_DAY));
}

/** A growth figure clamped to the model's window, in per cent. */
function clampPct(raw: number, model: ModelConstants): number {
  return Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
}

/** The maturity multiplier for a protocol of `age` days under `model`. */
function maturityFor(age: number | null, model: ModelConstants): number {
  const days = age ?? model.unknown_age_days;
  const bounded = Math.min(Math.max(days, 0), model.maturity_days);
  return model.maturity_floor + (bounded / model.maturity_days) * model.maturity_range;
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function scoreOne(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; discount: number; age: number | null } {
  const age = ageInDays(asOf, protocol.listed_at);
  const hasGrowth = protocol.change_7d !== null && Number.isFinite(protocol.change_7d);
  const growthPct = clampPct(hasGrowth ? (protocol.change_7d as number) : 0, model);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult = maturityFor(age, model);
  const discount = hasGrowth ? 1 : model.missing_growth_discount;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * discount));
  return { implied, growthPct, growthMult, maturityMult, discount, age };
}

/** The implied value the same protocol would carry at 0% seven-day growth: the detail view's sensitivity line. */
export function flatScoreOne(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): number {
  const age = ageInDays(asOf, protocol.listed_at);
  const maturityMult = maturityFor(age, model);
  const discount = protocol.change_7d !== null && Number.isFinite(protocol.change_7d)
    ? 1
    : model.missing_growth_discount;
  const base = protocol.tvl_usd * model.base_multiple;
  return Math.max(1, Math.round(base * maturityMult * discount));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function hasNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function canRank(p: SnapshotProtocol): boolean {
  return hasNoToken(p) && p.category !== 'CEX' && !VERSION_SUFFIX.test(p.name);
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function assembleBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const lookup = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = lookup.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a picked protocol stays picked.
  const earlyPicks = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && canRank(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of earlyPicks) picked.set(p.slug, p);

  const ranked = [...picked.values()].map((p) => {
    const scored = scoreOne(p, snapshot.as_of, model);
    return { p, ...scored };
  });
  ranked.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return ranked.map((hit, i) => ({
    rank: i + 1,
    slug: hit.p.slug,
    name: hit.p.name,
    category: hit.p.category,
    chains: hit.p.chains,
    tvl_usd: hit.p.tvl_usd,
    change_7d: hit.p.change_7d,
    mcap_usd: hit.p.mcap_usd,
    listed_at: hit.p.listed_at,
    gecko_id: hit.p.gecko_id,
    symbol: hit.p.symbol,
    token_status: 'pre-token',
    age_days: hit.age,
    implied_value_usd: hit.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: hit.growthPct,
      growth_multiplier: round4dp(hit.growthMult),
      maturity_multiplier: round4dp(hit.maturityMult),
      data_discount: hit.discount,
      age_days: hit.age,
    },
    farm_steps: planSteps(hit.p, hit.age).map(stepLine),
  }));
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepLine(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, from the snapshot's own chain names. */
export function gasPriceFor(chain: string): { usd: number; label: string } {
  const key = chain.toLowerCase();
  if (key === 'ethereum') return { usd: 8, label: 'about $8 of gas on Ethereum' };
  if (key === 'solana') return { usd: 0.05, label: 'about $0.05 of gas on Solana' };
  if (key === 'binance') return { usd: 0.3, label: 'about $0.30 of gas on BNB Chain' };
  if (key === 'base' || key === 'arbitrum' || key === 'optimism' || key === 'polygon' || key === 'avalanche') {
    return { usd: 1, label: `about $1 of gas on ${chain}` };
  }
  return { usd: 3, label: `about $3 of gas on ${chain}` };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalNeeded(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 10_000_000_000) return 300;
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdForAge(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
export function primaryAction(p: SnapshotProtocol, amount: number, chainName: string): string {
  const kind = (p.category ?? '').toLowerCase();
  const protocolName = p.name;
  if (kind.indexOf('lend') >= 0 || kind.indexOf('cdp') >= 0 || kind.indexOf('collateral') >= 0) return `Supply $${amount} of USDC to ${protocolName} on ${chainName} and keep the position open.`;
  if (kind.indexOf('dex') >= 0 || kind.indexOf('yield') >= 0 || kind.indexOf('leveraged farm') >= 0) return `Provide $${amount} of liquidity to the main pool of ${protocolName} on ${chainName} and keep the position open.`;
  if (kind.indexOf('bridge') >= 0 || kind.indexOf('canonical bridge') >= 0) return `Bridge $${amount} of USDC to ${chainName} through ${protocolName} and use the bridged funds in its app.`;
  if (kind.indexOf('staking') >= 0 || kind.indexOf('restak') >= 0) return `Stake $${amount} of the chain staking asset through ${protocolName} and keep the receipt.`;
  if (kind.indexOf('perpetual') >= 0 || kind.indexOf('derivative') >= 0 || kind.indexOf('basis trading') >= 0) return `Deposit $${amount} of USDC as margin on ${protocolName} and open one small hedge.`;
  if (kind.indexOf('prediction') >= 0) return `Fund $${amount} and place one market position on ${protocolName}.`;
  if (kind.indexOf('curator') >= 0 || kind.indexOf('allocator') >= 0 || kind.indexOf('onchain capital') >= 0) return `Deposit $${amount} into a ${protocolName} vault on ${chainName} and keep the shares.`;
  if (kind.indexOf('stable') >= 0) return `Mint or deposit $${amount} of the stable asset through ${protocolName} on ${chainName}.`;
  if (kind.indexOf('rwa') >= 0) return `Mint $${amount} of the yield asset of ${protocolName} on ${chainName} and hold it.`;
  if (kind.indexOf('insurance') >= 0) return `Buy $${amount} of cover from ${protocolName} on ${chainName} and keep the policy.`;
  if (kind.indexOf('ai agent') >= 0) return `Deposit $${amount} into the agent vault of ${protocolName} on ${chainName} and keep the position open.`;
  return `Deposit $${amount} of USDC into ${protocolName} on ${chainName} and keep the position open.`;
}

/** The category's second qualifying action: a different verb, so the plan is not one deposit. */
export function followUpAction(p: SnapshotProtocol, chainName: string): string {
  const kind = (p.category ?? '').toLowerCase();
  const protocolName = p.name;
  if (kind.indexOf('lend') >= 0 || kind.indexOf('cdp') >= 0 || kind.indexOf('collateral') >= 0) return `Borrow $10 against the supply on ${protocolName} and repay it the same week.`;
  if (kind.indexOf('dex') >= 0 || kind.indexOf('yield') >= 0 || kind.indexOf('leveraged farm') >= 0) return `Swap $25 through the main pool of ${protocolName} on ${chainName} so the position is not a single deposit.`;
  if (kind.indexOf('bridge') >= 0 || kind.indexOf('canonical bridge') >= 0) return `Bridge $10 back the other way through ${protocolName} once to show two-way use.`;
  if (kind.indexOf('staking') >= 0 || kind.indexOf('restak') >= 0) return `Claim or restake the staking rewards from ${protocolName} once.`;
  if (kind.indexOf('perpetual') >= 0 || kind.indexOf('derivative') >= 0 || kind.indexOf('basis trading') >= 0) return `Close the hedge on ${protocolName} and open one fresh small position.`;
  if (kind.indexOf('prediction') >= 0) return `Close the first market position on ${protocolName} once it settles.`;
  if (kind.indexOf('curator') >= 0 || kind.indexOf('allocator') >= 0 || kind.indexOf('onchain capital') >= 0) return `Top up the ${protocolName} vault by $10 and keep the new shares.`;
  if (kind.indexOf('stable') >= 0) return `Redeem a small amount back to USDC through ${protocolName} and deposit it again.`;
  if (kind.indexOf('rwa') >= 0) return `Claim the yield distribution of ${protocolName} once.`;
  if (kind.indexOf('insurance') >= 0) return `Top up the cover from ${protocolName} by $10 and keep the policy.`;
  return `Make one swap or vote inside the app of ${protocolName} on ${chainName}.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Gas follows the chain the snapshot names; capital follows the TVL tier; the hold follows
 * the age.
 */
export function planSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const gas = gasPriceFor(chain);
  const capital = capitalNeeded(p);
  const hold = holdForAge(age);
  const action = primaryAction(p, capital, chain);
  const second = followUpAction(p, chain);
  const weeklyGas = gas.usd < 1
    ? `$${gas.usd} of gas a week`
    : `about $${gas.usd} of gas a week`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gas.label}`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `about $${gas.usd < 1 ? gas.usd : Math.round(gas.usd)} of gas plus the $10 to $25 moved`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: weeklyGas,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the points or rewards page of ${p.name} and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log, then unwind in reverse order and keep gas aside for the exit transactions.`,
      cost: `exit gas, ${gas.label}`,
      time: '10 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveList(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function compactRow(row: BoardRow, watchlist?: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    data_discount: row.model.data_discount,
    watchlist: watchlist !== undefined ? watchlist.has(row.slug) : false,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = assembleBoard(snapshot, model);
  const live = liveList(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => compactRow(r, new Set(snapshot.watchlist))),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((item, idx) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SnapshotError(`snapshot.json's protocol ${idx} is not an object`);
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.slug !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.tvl_usd !== 'number' ||
      !Number.isFinite(entry.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json's protocol ${idx} lacks a slug, a name or a TVL`);
    }
    return {
      slug: entry.slug,
      name: entry.name,
      category: typeof entry.category === 'string' ? entry.category : null,
      chains: Array.isArray(entry.chains)
        ? entry.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: entry.tvl_usd,
      change_7d: typeof entry.change_7d === 'number' && Number.isFinite(entry.change_7d)
        ? entry.change_7d
        : null,
      mcap_usd: typeof entry.mcap_usd === 'number' && Number.isFinite(entry.mcap_usd)
        ? entry.mcap_usd
        : null,
      listed_at: typeof entry.listed_at === 'string' ? entry.listed_at : null,
      gecko_id: typeof entry.gecko_id === 'string' ? entry.gecko_id : null,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
    };
  });
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const seen = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !seen.has(s));
  if (absent.length > 0) {
    return `the board misses ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  }
  const ordered = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i] !== i + 1) return `rank ${i + 1} is ${ordered[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    const plan = row.farm_steps;
    if (plan.length < 3 || plan.length > 12) return `${row.slug} has ${plan.length} farm steps`;
    for (const step of plan) {
      if (step.length < 20 || step.length > 600) {
        return `${row.slug} has a farm step of ${step.length} characters`;
      }
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
