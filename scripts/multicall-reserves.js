// scripts/multicall-reserves.js
//
// Multicall3(対応チェーン全てに同一アドレスで存在する標準コントラクト)を
// 使い、多数のプールやトークンのデータを「1回のRPC呼び出し」でまとめて読む。
//
// [なぜ束ねるか(2026年9月16日)]
// Chainstackは問い合わせ1回=1リクエスト単位で課金され、中身の大きさは問わない。
// V3の価格表(1プールあたりQuoter12回)やV3の状態(1プールあたり2回)を個別に
// 呼んでいたため、Polygonだけで月約1,100万単位に達し、2,000万の枠を圧迫していた。
// 100件を1回に束ねれば、単位の消費は1/100になる。
//
// [束ねる大きさ]
// Quoterは1件あたり数十万ガスを使うため、1回に詰めすぎるとノード側の
// ガス上限に当たる。Quoterは24件、状態読みは60件、準備量は100件を上限にし、
// 1回の呼び出しが失敗したら半分に割って再試行する。
//
// RPCへの接続は onchain-reserves.js の callWithRpc を経由するので、
// タイムアウト・待ち行列・RPC自動切り替えがそのまま適用される。

import { ethers } from "ethers";
import { callWithRpc, readBlockTag } from "./onchain-reserves.js";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const PAIR_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
const V3_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/// 自前コントラクトの見積もり。プールのアドレスを直接渡すため、
/// ファクトリーが何であっても使える(Uniswapのフォーク、Algebra系を含む)。
/// QuoterV2 と同じで、結果は「わざと失敗させて」エラーとして返る。
const FORK_QUOTER_IFACE = new ethers.Interface([
  "function quoteV3(address pool, address tokenIn, uint256 amountIn)",
  "error QuoteResult(uint256 amountOut)",
]);

/// V3型ファクトリーへの「このペアのプールはあるか」の照会。
/// Algebra系は手数料が動的なので、手数料帯の引数を取らない poolByPair を使う。
const V3_FACTORY_IFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function poolByPair(address tokenA, address tokenB) view returns (address)",
]);

const MAX_POOLS_PER_CALL = parseInt(process.env.MULTICALL_POOLS_PER_CALL || "100", 10);
const MAX_TOKENS_PER_CALL = 120;
const MAX_V3_POOLS_PER_CALL = parseInt(process.env.MULTICALL_V3_PER_CALL || "60", 10);
const MAX_QUOTES_PER_CALL = parseInt(process.env.MULTICALL_QUOTES_PER_CALL || "24", 10);
const MAX_FACTORY_LOOKUPS_PER_CALL = parseInt(process.env.MULTICALL_FACTORY_PER_CALL || "250", 10);

const multicallStats = { calls: 0, subcalls: 0, splits: 0 };
export function getMulticallStats() { return { ...multicallStats }; }

async function multicall(chain, calls, priority = false) {
  multicallStats.calls++;
  multicallStats.subcalls += calls.length;
  return callWithRpc(chain, (provider) =>
    // Flashblocks のチェーンでは確定前(pending)の状態を読む。他は latest(今までどおり)。
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider).aggregate3(calls, { blockTag: readBlockTag(chain) }), priority);
}

/// 失敗したら半分に割って再試行する。1件まで割っても失敗した分は null。
async function multicallSplitting(chain, calls, priority = false, minChunk = 4) {
  try {
    return await multicall(chain, calls, priority);
  } catch (e) {
    if (calls.length <= minChunk) return calls.map(() => null);
    multicallStats.splits++;
    const half = Math.ceil(calls.length / 2);
    const [a, b] = await Promise.all([
      multicallSplitting(chain, calls.slice(0, half), priority, minChunk),
      multicallSplitting(chain, calls.slice(half), priority, minChunk),
    ]);
    return [...a, ...b];
  }
}

/// 複数プールの準備量とtoken0を一括で読む。
/// 戻り値: Map<小文字アドレス, { raw0, raw1, token0 } | null(読めない)>
export async function fetchReservesBatch(chain, pools, priority = false) {
  const result = new Map();
  for (let i = 0; i < pools.length; i += MAX_POOLS_PER_CALL) {
    const chunk = pools.slice(i, i + MAX_POOLS_PER_CALL);
    const calls = [];
    for (const p of chunk) {
      const target = ethers.getAddress(p.address);
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("getReserves") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token0") });
    }
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].address.toLowerCase();
      const r1 = returned[j * 2], r2 = returned[j * 2 + 1];
      if (!r1?.success || !r2?.success || r1.returnData === "0x" || r2.returnData === "0x") {
        result.set(key, null);
        continue;
      }
      try {
        const reserves = PAIR_IFACE.decodeFunctionResult("getReserves", r1.returnData);
        const token0 = PAIR_IFACE.decodeFunctionResult("token0", r2.returnData)[0];
        result.set(key, { raw0: reserves[0], raw1: reserves[1], token0 });
      } catch (e) {
        result.set(key, null);
      }
    }
  }
  return result;
}

// ===== Algebra系の状態の読み取り =====
//
// Algebra は slot0() を持たず globalState() で価格を返す。返り値の並びは
// 版によって違う(V1は7個、Integralは6個で中身も別物)が、先頭2つ
//   uint160 price / int24 tick
// はどの版でも共通。そこでABIで丸ごと復号せず、先頭2語だけを自前で読む。
// 丸ごと復号すると、版が違うだけで失敗して価格が取れなくなる。
const GLOBAL_STATE_SELECTOR = ethers.id("globalState()").slice(0, 10);

/// globalState() の返り値から先頭2語(価格とtick)だけを読む。
function decodeGlobalStateHead(returnData) {
  const hex = returnData.startsWith("0x") ? returnData.slice(2) : returnData;
  if (hex.length < 128) return null;
  try {
    const sqrtPriceX96 = BigInt("0x" + hex.slice(0, 64));
    let tick = BigInt("0x" + hex.slice(64, 128));
    // int24 は32バイトに符号拡張されて入っている。負の値を戻す。
    if (tick >= 1n << 255n) tick -= 1n << 256n;
    return { sqrtPriceX96, tick: Number(tick) };
  } catch (e) {
    return null;
  }
}

/// 一度 globalState() で読めたプールを覚えておき、次からは slot0() を
/// 試さずに直接こちらへ回す(毎回1回分の無駄な呼び出しを省くため)。
const algebraPools = new Set();

/// 複数のV3プールの価格と流動性を一括で読む。
/// Uniswap形式は slot0()、Algebra形式は globalState() を使う。
/// 戻り値: Map<小文字アドレス, { sqrtPriceX96, tick, liquidity } | null>
export async function fetchV3StatesBatch(chain, addresses, priority = false) {
  const result = new Map();
  // 既知のAlgebraプールは最初から globalState() 側に回す。
  const algebraQueue = [];
  const uniswapQueue = [];
  for (const addr of addresses) {
    (algebraPools.has(`${chain}:${addr.toLowerCase()}`) ? algebraQueue : uniswapQueue).push(addr);
  }

  for (let i = 0; i < uniswapQueue.length; i += MAX_V3_POOLS_PER_CALL) {
    const chunk = uniswapQueue.slice(i, i + MAX_V3_POOLS_PER_CALL);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: V3_IFACE.encodeFunctionData("slot0") });
      calls.push({ target, allowFailure: true, callData: V3_IFACE.encodeFunctionData("liquidity") });
    }
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].toLowerCase();
      const r1 = returned[j * 2], r2 = returned[j * 2 + 1];
      if (!r1?.success || !r2?.success || r1.returnData === "0x" || r2.returnData === "0x") {
        result.set(key, null);
        // slot0() の呼び出し自体が失敗した時だけ、Algebra形式の可能性を試す。
        // 価格が0で返ってきた場合(未初期化のプール)はここに入れない。
        if (!r1?.success || r1.returnData === "0x") algebraQueue.push(chunk[j]);
        continue;
      }
      try {
        const slot0 = V3_IFACE.decodeFunctionResult("slot0", r1.returnData);
        const liquidity = V3_IFACE.decodeFunctionResult("liquidity", r2.returnData)[0];
        if (slot0[0] <= 0n) { result.set(key, null); continue; }
        result.set(key, { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity });
      } catch (e) {
        result.set(key, null);
      }
    }
  }

  for (let i = 0; i < algebraQueue.length; i += MAX_V3_POOLS_PER_CALL) {
    const chunk = algebraQueue.slice(i, i + MAX_V3_POOLS_PER_CALL);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: GLOBAL_STATE_SELECTOR });
      calls.push({ target, allowFailure: true, callData: V3_IFACE.encodeFunctionData("liquidity") });
    }
    let returned;
    try {
      returned = await multicallSplitting(chain, calls, priority);
    } catch (e) {
      continue; // 読めなければ、そのプールは今回は状態なしのまま
    }
    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].toLowerCase();
      const r1 = returned[j * 2], r2 = returned[j * 2 + 1];
      if (!r1?.success || !r2?.success || r1.returnData === "0x" || r2.returnData === "0x") {
        if (!result.has(key)) result.set(key, null);
        continue;
      }
      const head = decodeGlobalStateHead(r1.returnData);
      if (!head || head.sqrtPriceX96 <= 0n) {
        if (!result.has(key)) result.set(key, null);
        continue;
      }
      try {
        const liquidity = V3_IFACE.decodeFunctionResult("liquidity", r2.returnData)[0];
        result.set(key, { ...head, liquidity });
        algebraPools.add(`${chain}:${key}`);
      } catch (e) {
        if (!result.has(key)) result.set(key, null);
      }
    }
  }

  return result;
}

/// 公式QuoterV2への見積もりを一括で行う。
/// @param requests [{ tokenIn, tokenOut, amountIn, feeTier }] の配列
/// 戻り値: 同じ順番の配列。見積もれなかったものは null。
export async function quoteV3Batch(chain, quoterAddress, requests, priority = false) {
  const out = new Array(requests.length).fill(null);
  if (!quoterAddress || requests.length === 0) return out;
  const target = ethers.getAddress(quoterAddress);
  for (let i = 0; i < requests.length; i += MAX_QUOTES_PER_CALL) {
    const chunk = requests.slice(i, i + MAX_QUOTES_PER_CALL);
    const calls = chunk.map((q) => ({
      target, allowFailure: true,
      callData: QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{
        tokenIn: ethers.getAddress(q.tokenIn),
        tokenOut: ethers.getAddress(q.tokenOut),
        amountIn: q.amountIn,
        fee: q.feeTier,
        sqrtPriceLimitX96: 0,
      }]),
    }));
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const amountOut = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", r.returnData)[0];
        if (amountOut > 0n) out[i + j] = amountOut;
      } catch (e) {}
    }
  }
  return out;
}

/// 複数トークンの桁数(decimals)を一括で読む。
/// 経路の始点として使えるかの判断に必要。桁数が読めないトークンは
/// 量の計算ができないため、始点にしない。
/// 戻り値: Map<小文字アドレス, 数値>
/// 自前コントラクトの quoteV3 で受取量をまとめて求める。
///
/// [なぜ要るか(2026年9月17日)]
/// Uniswap公式の QuoterV2 は quoteExactInputSingle(tokenIn, tokenOut, fee) の形で、
/// 引数にプールのアドレスが無い。中に固定されたファクトリーからアドレスを
/// 計算するため、フォークのプールには一切届かない。
/// 一方 legIsUsable() はV3の段に価格表を要求するので、価格表が作れない
/// プールは経路に使えない。これが Polygon の RamsesX(V3 Swapの22%)も
/// Optimism/Base の未監視ファクトリーも取れない根本原因だった。
/// プールのアドレスを直接受け取る形にすれば、ファクトリーを問わず見積もれる。
///
/// [結果の受け取り方]
/// QuoterV2 と同じで、スワップを実行してからわざと失敗させ、受取量を
/// エラーとして返す。aggregate3 は allowFailure なら失敗した呼び出しの
/// 戻りデータもそのまま返すので、そこから QuoteResult を読む。
///
/// @param requests [{ pool, tokenIn, amountIn }] の配列
/// 戻り値: 同じ順番の配列。見積もれなかったものは null。
export async function quoteV3ByPoolBatch(chain, contractAddress, requests, priority = false) {
  const out = new Array(requests.length).fill(null);
  if (!contractAddress || requests.length === 0) return out;
  const target = ethers.getAddress(contractAddress);

  for (let i = 0; i < requests.length; i += MAX_QUOTES_PER_CALL) {
    const chunk = requests.slice(i, i + MAX_QUOTES_PER_CALL);
    const calls = chunk.map((q) => ({
      target, allowFailure: true,
      callData: FORK_QUOTER_IFACE.encodeFunctionData("quoteV3", [
        ethers.getAddress(q.pool), ethers.getAddress(q.tokenIn), q.amountIn,
      ]),
    }));
    let returned;
    try {
      returned = await multicall(chain, calls, priority);
    } catch (e) {
      continue; // この塊は諦める。呼び出し側は null のまま扱う。
    }
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r || !r.returnData || r.returnData === "0x") continue;
      try {
        const parsed = FORK_QUOTER_IFACE.parseError(r.returnData);
        if (parsed && parsed.name === "QuoteResult") {
          const amountOut = parsed.args.amountOut;
          if (amountOut > 0n) out[i + j] = amountOut;
        }
      } catch (inner) {}
    }
  }
  return out;
}

/// ファクトリーに「このペアのプールはあるか」をまとめて聞く。
///
/// [なぜ一括にするか(2026年9月18日)]
/// findV3Pool は1ペアにつきRPCを1回使う。探索対象を24種に広げると
/// 276ペア×13通り=3,588回になり、1回ずつでは現実的でない。
/// Multicall3で束ねれば同じ内容が十数回で済む。
///
/// @param requests [{ tokenA, tokenB, feeTier }] / style は "uniswap" か "algebra"
/// 戻り値: requests と同じ並びのアドレス配列(見つからなければ null)
export async function findV3PoolsBatch(chain, factory, style, requests) {
  const out = new Array(requests.length).fill(null);
  if (requests.length === 0) return out;
  const target = ethers.getAddress(factory);
  const isAlgebra = style === "algebra";
  const fn = isAlgebra ? "poolByPair" : "getPool";

  for (let i = 0; i < requests.length; i += MAX_FACTORY_LOOKUPS_PER_CALL) {
    const chunk = requests.slice(i, i + MAX_FACTORY_LOOKUPS_PER_CALL);
    const calls = [];
    for (const r of chunk) {
      const args = isAlgebra
        ? [ethers.getAddress(r.tokenA), ethers.getAddress(r.tokenB)]
        : [ethers.getAddress(r.tokenA), ethers.getAddress(r.tokenB), r.feeTier];
      calls.push({ target, allowFailure: true, callData: V3_FACTORY_IFACE.encodeFunctionData(fn, args) });
    }
    const returned = await multicallSplitting(chain, calls);
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const addr = V3_FACTORY_IFACE.decodeFunctionResult(fn, r.returnData)[0];
        if (addr && addr !== ethers.ZeroAddress) out[i + j] = addr;
      } catch (e) {}
    }
  }
  return out;
}

export async function fetchTokenDecimalsBatch(chain, addresses) {
  const result = new Map();
  for (let i = 0; i < addresses.length; i += MAX_TOKENS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_TOKENS_PER_CALL);
    const calls = chunk.map((addr) => ({
      target: ethers.getAddress(addr),
      allowFailure: true,
      callData: ERC20_IFACE.encodeFunctionData("decimals"),
    }));
    const returned = await multicallSplitting(chain, calls);
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const decimals = Number(ERC20_IFACE.decodeFunctionResult("decimals", r.returnData)[0]);
        if (decimals >= 0 && decimals <= 36) result.set(chunk[j].toLowerCase(), decimals);
      } catch (e) {}
    }
  }
  return result;
}

/// 複数プールの token0 / token1 / stable を一括で読む。
/// stable型(x³y+y³x曲線)は計算式が違うため、結果から除外する。
/// 戻り値: Map<小文字アドレス, { token0, token1 }>
export async function fetchPoolTokensBatch(chain, addresses) {
  const result = new Map();
  const perChunk = Math.floor(MAX_POOLS_PER_CALL * 2 / 3);
  for (let i = 0; i < addresses.length; i += perChunk) {
    const chunk = addresses.slice(i, i + perChunk);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token0") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token1") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("stable") });
    }
    const returned = await multicallSplitting(chain, calls);
    for (let j = 0; j < chunk.length; j++) {
      const r0 = returned[j * 3], r1 = returned[j * 3 + 1], rs = returned[j * 3 + 2];
      if (!r0?.success || !r1?.success || r0.returnData === "0x" || r1.returnData === "0x") continue;
      try {
        const token0 = PAIR_IFACE.decodeFunctionResult("token0", r0.returnData)[0];
        const token1 = PAIR_IFACE.decodeFunctionResult("token1", r1.returnData)[0];
        if (token0.toLowerCase() === token1.toLowerCase()) continue;
        if (rs?.success && rs.returnData !== "0x") {
          try {
            if (PAIR_IFACE.decodeFunctionResult("stable", rs.returnData)[0]) continue;
          } catch (e) {}
        }
        result.set(chunk[j].toLowerCase(), { token0: token0.toLowerCase(), token1: token1.toLowerCase() });
      } catch (e) {}
    }
  }
  return result;
}
