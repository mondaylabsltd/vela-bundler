/**
 * Alchemy RPC support.
 *
 * When an Alchemy API key is configured, supported chains use Alchemy's
 * premium RPC instead of public RPCs. This provides better reliability,
 * higher rate limits, and trace/debug support.
 *
 * Reference: https://www.alchemy.com/docs/reference/node-supported-chains
 * Last updated: 2026-05-12
 */

/**
 * Alchemy network slugs keyed by chainId.
 * URL pattern: https://{slug}.g.alchemy.com/v2/{apiKey}
 *
 * Only EVM-compatible chains are included (non-EVM like Solana, Bitcoin,
 * Aptos, Sui, Starknet, Tron are excluded as they use different RPC protocols).
 */
const ALCHEMY_CHAINS: Record<number, string> = {
  // ── Ethereum ──
  1: "eth-mainnet",
  11155111: "eth-sepolia",
  17000: "eth-holesky",
  560048: "eth-hoodi",

  // ── Polygon PoS ──
  137: "polygon-mainnet",
  80002: "polygon-amoy",

  // ── Arbitrum ──
  42161: "arb-mainnet",
  421614: "arb-sepolia",

  // ── OP Mainnet (Optimism) ──
  10: "opt-mainnet",
  11155420: "opt-sepolia",

  // ── Base ──
  8453: "base-mainnet",
  84532: "base-sepolia",

  // ── BNB Smart Chain ──
  56: "bnb-mainnet",
  97: "bnb-testnet",

  // ── X Layer (OKX) ──
  196: "xlayer-mainnet",

  // ── Avalanche C-Chain ──
  43114: "avax-mainnet",
  43113: "avax-fuji",

  // ── zkSync ──
  324: "zksync-mainnet",
  300: "zksync-sepolia",

  // ── Polygon zkEVM ──
  1101: "polygonzkevm-mainnet",
  2442: "polygonzkevm-cardona",

  // ── Scroll ──
  534352: "scroll-mainnet",
  534351: "scroll-sepolia",

  // ── Linea ──
  59144: "linea-mainnet",
  59141: "linea-sepolia",

  // ── Blast ──
  81457: "blast-mainnet",
  168587773: "blast-sepolia",

  // ── Mantle ──
  5000: "mantle-mainnet",
  5003: "mantle-sepolia",

  // ── World Chain ──
  480: "worldchain-mainnet",
  4801: "worldchain-sepolia",

  // ── Gnosis ──
  100: "gnosis-mainnet",
  10200: "gnosis-chiado",

  // ── Berachain ──
  80094: "berachain-mainnet",
  80069: "berachain-bepolia",

  // ── Shape ──
  360: "shape-mainnet",
  11011: "shape-sepolia",

  // ── Sonic ──
  146: "sonic-mainnet",
  64165: "sonic-testnet",
  57054: "sonic-blaze",

  // ── Sei ──
  1329: "sei-mainnet",
  1328: "sei-testnet",

  // ── Celo ──
  42220: "celo-mainnet",
  44787: "celo-sepolia",

  // ── Flow EVM ──
  747: "flow-mainnet",
  545: "flow-testnet",

  // ── Astar ──
  592: "astar-mainnet",

  // ── ZetaChain ──
  7000: "zetachain-mainnet",
  7001: "zetachain-testnet",

  // ── Unichain ──
  130: "unichain-mainnet",
  1301: "unichain-sepolia",

  // ── ApeChain ──
  33139: "apechain-mainnet",
  33111: "apechain-curtis",

  // ── Ink ──
  57073: "ink-mainnet",
  763373: "ink-sepolia",

  // ── Abstract ──
  2741: "abstract-mainnet",
  11124: "abstract-testnet",

  // ── Soneium ──
  1868: "soneium-mainnet",
  1946: "soneium-minato",

  // ── Lens ──
  37111: "lens-mainnet",
  37112: "lens-sepolia",

  // ── opBNB ──
  204: "opbnb-mainnet",
  5611: "opbnb-testnet",

  // ── Rootstock ──
  30: "rootstock-mainnet",
  31: "rootstock-testnet",

  // ── Metis ──
  1088: "metis-mainnet",

  // ── CrossFi ──
  4157: "crossfi-mainnet",
  4158: "crossfi-testnet",

  // ── Moonbeam ──
  1284: "moonbeam-mainnet",

  // ── Mode ──
  34443: "mode-mainnet",
  919: "mode-sepolia",

  // ── Frax ──
  252: "frax-mainnet",
  2523: "frax-hoodi",

  // ── Zora ──
  7777777: "zora-mainnet",
  999999999: "zora-sepolia",

  // ── Boba ──
  288: "boba-mainnet",
  28882: "boba-sepolia",

  // ── Superseed ──
  5330: "superseed-mainnet",
  53302: "superseed-sepolia",

  // ── Botanix ──
  3637: "botanix-mainnet",
  3636: "botanix-testnet",

  // ── Polynomial ──
  8008: "polynomial-mainnet",
  80008: "polynomial-sepolia",

  // ── Degen ──
  666666666: "degen-mainnet",
  69420: "degen-sepolia",

  // ── HyperEVM (Hyperliquid) ──
  999: "hyperliquid-mainnet",
  998: "hyperliquid-testnet",

  // ── Anime ──
  69000: "anime-mainnet",
  6900: "anime-sepolia",

  // ── Story ──
  1514: "story-mainnet",
  1513: "story-aeneid",

  // ── Ronin ──
  2020: "ronin-mainnet",
  2021: "ronin-saigon",

  // ── BOB ──
  60808: "bob-mainnet",
  808813: "bob-sepolia",

  // ── MegaETH ──
  4326: "megaeth-mainnet",
  6343: "megaeth-testnet",

  // ── Monad ──
  143: "monad-mainnet",
  10143: "monad-testnet",

  // ── RISE ──
  4153: "rise-mainnet",
  11155931: "rise-testnet",

  // ── RACE ──
  6805: "race-mainnet",
  6806: "race-sepolia",

  // ── Citrea ──
  4114: "citrea-mainnet",
  5115: "citrea-testnet",

  // ── Galactica ──
  613419: "galactica-mainnet",
  843843: "galactica-cassiopeia",

  // ── Humanity ──
  6985385: "humanity-mainnet",
  7080969: "humanity-testnet",

  // ── Stable ──
  988: "stable-mainnet",
  2201: "stable-testnet",

  // ── Edge ──
  3343: "edge-mainnet",

  // ── Plasma ──
  9745: "plasma-mainnet",
  9746: "plasma-testnet",

  // ── Unite ──
  88899: "unite-mainnet",
  888991: "unite-testnet",

  // ── Tempo ──
  4217: "tempo-mainnet",
  42431: "tempo-moderato",

  // ── Mythos ──
  201804: "mythos-mainnet",

  // ── Tea ──
  10218: "tea-sepolia",

  // ── Settlus ──
  5371: "settlus-mainnet",
  5373: "settlus-septestnet",

  // ── Syndicate ──
  510: "synd-mainnet",

  // ── Commons ──
  510003: "commons-mainnet",

  // ── World Mobile Chain ──
  869: "worldmobilechain-mainnet",

  // ── ADI ──
  99999: "adi-testnet",
};

/**
 * Check if Alchemy supports a given chainId.
 */
export function isAlchemySupported(chainId: number): boolean {
  return chainId in ALCHEMY_CHAINS;
}

/**
 * Build an Alchemy RPC URL for the given chainId.
 * Returns null if the chain is not supported by Alchemy.
 */
export function buildAlchemyRpcUrl(chainId: number, apiKey: string): string | null {
  const slug = ALCHEMY_CHAINS[chainId];
  if (!slug) return null;
  return `https://${slug}.g.alchemy.com/v2/${apiKey}`;
}

/**
 * Get all Alchemy-supported chain IDs.
 */
export function getAlchemySupportedChainIds(): number[] {
  return Object.keys(ALCHEMY_CHAINS).map(Number);
}
