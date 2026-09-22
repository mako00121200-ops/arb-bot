const m = await import("/home/user/arb-bot/scripts/pair-filler.js");
const u = await import("/home/user/arb-bot/scripts/uniswapx-probe.js");
let n=0,bad=0; const ck=(t,c)=>{n++; if(!c){bad++;console.log("NG",t);}};
ck("pair-filler が読み込める",       typeof m.fillMissingPairsOnce === "function");
ck("getMissingPairs が使える",       typeof u.getMissingPairs === "function");
ck("forgetMissingPair が使える",     typeof u.forgetMissingPair === "function");
ck("組が無ければ空",                 u.getMissingPairs().length === 0);
ck("空なら生存ログも空",             u.formatMissingPairsLine() === "");
ck("まだ調べていなければ行も空",     m.formatPairFillLine() === "");
// **知らないチェーンでは何もしないこと**(RPCを無駄打ちしない)
await m.fillMissingPairsOnce([]);
ck("対象チェーン無しでも落ちない",   m.getPairFillStats().pairsTried === 0);
console.log(bad===0?`全${n}件 合格`:`${bad}/${n} 不合格`);
