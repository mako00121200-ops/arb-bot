// Base 上の Limitless の取引所コントラクトから、約定(OrderFilled)と払い戻し(PayoutRedemption)を読む。
//
// [なぜ必要か]
// 板(orderbook)には誰が出したかが無い。一方、約定は全て Base 上で決済されるので、
// maker / taker のアドレス・価格・数量・手数料が公開されている。
// これを貯めれば「どのアドレスが、満期の何秒前に、どちら側を、いくらで取っているか」が
// 全部分かり、勝ち続けているアドレスの戦術をそのまま観察できる。
// 既存の DEX bot の competitor-check.js(誰が取ったか)と同じ発想。
//
// [イベントの形は Polymarket の CTF Exchange を前提にしている]
// Limitless は "Limitless CTF Exchange" と名乗る Polymarket 系のフォーク。
// 署名が違えば decode されずに「未知の topic」として件数だけ記録されるので、
// 起動後の chain_topics 行で必ず確認すること。

import { JsonRpcProvider, AbiCoder, getAddress } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();

// keccak256 で計算済み(limitless/ で `node -e` により確認、2026年9月25日)
export const TOPICS = {
  OrderFilled: '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6',
  OrdersMatched: '0x63bf4d16b7fa898ef4c4b2b6d90fd201e9c56313b65638af6088d149d2ce956c',
  PayoutRedemption: '0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d',
  PositionSplit: '0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298',
  PositionsMerge: '0x6f13ca62553fcc2bcd2372180a43949c1e4cebba603901ede2f4e14f36b282ca',
  ConditionResolution: '0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894',
};
const TOPIC_NAME = Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [v, k]));

// Limitless-API-Docs/docs/contracts.md より(Base, chainId 8453)
export const CONTRACTS = {
  conditionalTokens: '0xc9c98965297bc527861c898329ee280632b76e18',
  exchanges: [
    '0xa4409D988CA2218d956BeEFD3874100F444f0DC3', // CTF Exchange v1
    '0xF1De958F8641448A5ba78c01f434085385Af096D', // v2
    '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5', // v3
    '0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6', // NegRisk CTF Exchange v1
    '0x46e607D3f4a8494B0aB9b304d1463e2F4848891d', // v2
    '0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47', // v3
  ],
};

const topicToAddress = (t) => getAddress('0x' + t.slice(26));

// OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker,
//             uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)
// assetId 0 = 担保(USDC)。maker が USDC を出していれば maker は買い手。
export function decodeOrderFilled(log) {
  const [makerAssetId, takerAssetId, makerAmount, takerAmount, fee] = abi.decode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256'], log.data);
  const makerBuys = makerAssetId === 0n;
  const tokenId = (makerBuys ? takerAssetId : makerAssetId).toString();
  const usdc = Number(makerBuys ? makerAmount : takerAmount) / 1e6;
  const shares = Number(makerBuys ? takerAmount : makerAmount) / 1e6;
  return {
    orderHash: log.topics[1],
    maker: topicToAddress(log.topics[2]),
    taker: topicToAddress(log.topics[3]),
    tokenId,
    makerSide: makerBuys ? 'BUY' : 'SELL',
    usdc,
    shares,
    price: shares > 0 ? usdc / shares : null,
    feeUsdc: Number(fee) / 1e6,
  };
}

// PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId,
//                  bytes32 conditionId, uint256[] indexSets, uint256 payout)
export function decodePayoutRedemption(log) {
  const [conditionId, indexSets, payout] = abi.decode(['bytes32', 'uint256[]', 'uint256'], log.data);
  return { redeemer: topicToAddress(log.topics[1]), conditionId, indexSets: indexSets.map((x) => Number(x)), payoutUsdc: Number(payout) / 1e6 };
}

// 監視ループ。resolveToken(tokenId) は { slug, outcome, ... } か null を返す関数。
export function startChainWatcher({ rpcUrl, writeRow, logRawOnce, resolveToken, resolveCondition, intervalMs = 30000, maxBlocks = 300, onLatency }) {
  const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true, batchMaxCount: 1 });
  const addresses = [CONTRACTS.conditionalTokens, ...CONTRACTS.exchanges].map((a) => a.toLowerCase());
  let last = null;
  let topicCounts = {};
  let lastTopicReport = Date.now();
  let backoff = intervalMs;

  async function tick() {
    const t0 = Date.now();
    try {
      const latest = await provider.getBlockNumber();
      onLatency?.('rpc_blockNumber', Date.now() - t0);
      const from = last === null ? Math.max(0, latest - 15) : last + 1;
      if (from > latest) return;
      const to = Math.min(latest, from + maxBlocks - 1);
      const logs = await provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
      last = to;
      backoff = intervalMs;
      // ブロック時刻は、約定のあったブロックだけ取りに行く(多くても20ブロック)
      const blockTimes = new Map();
      const distinct = [...new Set(logs.map((l) => l.blockNumber))].slice(0, 20);
      for (const bn of distinct) {
        try { const b = await provider.getBlock(bn); if (b) blockTimes.set(bn, b.timestamp * 1000); } catch {}
      }
      for (const log of logs) {
        const topic0 = log.topics[0];
        const key = `${log.address.toLowerCase()}:${topic0}`;
        topicCounts[key] = (topicCounts[key] || 0) + 1;
        const name = TOPIC_NAME[topic0] ?? null;
        const base = { block: log.blockNumber, blockTime: blockTimes.get(log.blockNumber) ?? null, tx: log.transactionHash, logIndex: log.index, contract: log.address, event: name };
        if (name === 'OrderFilled') {
          let d;
          try { d = decodeOrderFilled(log); } catch (e) { writeRow('error', { where: 'decodeOrderFilled', msg: e.message, tx: log.transactionHash }); continue; }
          logRawOnce('chain:OrderFilled', { ...base, ...d });
          const mk = resolveToken?.(d.tokenId) ?? null;
          writeRow('fill', { ...base, ...d, slug: mk?.slug ?? null, outcome: mk?.outcome ?? null, kind: mk?.kind ?? null, expiryTs: mk?.expiryTs ?? null, secToExpiry: mk?.expiryTs && base.blockTime ? Math.round((mk.expiryTs - base.blockTime) / 1000) : null, K: mk?.openPrice ?? null });
        } else if (name === 'PayoutRedemption') {
          let d;
          try { d = decodePayoutRedemption(log); } catch (e) { writeRow('error', { where: 'decodePayoutRedemption', msg: e.message, tx: log.transactionHash }); continue; }
          logRawOnce('chain:PayoutRedemption', { ...base, ...d });
          const mk = resolveCondition?.(d.conditionId) ?? null;
          writeRow('redeem', { ...base, ...d, slug: mk?.slug ?? null, kind: mk?.kind ?? null });
        } else if (name) {
          logRawOnce(`chain:${name}`, { ...base, topics: log.topics, data: log.data.slice(0, 200) });
        } else {
          // 未知のイベント。署名の確認用に、topic ごとに1件だけ生で残す
          logRawOnce(`chain:unknown:${topic0.slice(0, 10)}`, { ...base, topics: log.topics, data: log.data.slice(0, 200) });
        }
      }
      if (Date.now() - lastTopicReport > 5 * 60000) {
        writeRow('chain_topics', { from, to, counts: topicCounts, names: TOPIC_NAME });
        console.log(`[チェーン] ブロック${to}まで読了。5分間のイベント件数=${JSON.stringify(Object.fromEntries(Object.entries(topicCounts).map(([k, v]) => [`${k.slice(0, 8)}…:${TOPIC_NAME[k.split(':')[1]] ?? k.split(':')[1].slice(0, 10)}`, v])))}`);
        topicCounts = {};
        lastTopicReport = Date.now();
      }
    } catch (e) {
      writeRow('error', { where: 'chain', msg: e.message });
      backoff = Math.min(backoff * 2, 5 * 60000);
    } finally {
      setTimeout(tick, backoff);
    }
  }
  tick();
  return { getLastBlock: () => last };
}
