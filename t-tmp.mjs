process.env.AAVE_STATE_FILE = "/tmp/aave-test-state.json";
const m = await import("./scripts/aave-liquidation.js");
console.log("読み込みOK。書き出し:", Object.keys(m).join(", "));
console.log("生存ログ(チェーン未確認のうち):", JSON.stringify(m.formatAaveLine()));
console.log("間隔:", m.AAVE_SWEEP_INTERVAL_MS, m.AAVE_WATCH_INTERVAL_MS);
// 幅の自動調整が想定どおり育つか(2000→上限50000で頭打ち)
let w = 2000; const seq = [];
for (let i = 0; i < 6; i++) { w = Math.min(50000, w * 2); seq.push(w); }
console.log("幅の育ち方:", seq.join(" → "));
console.log("10分あたりの遡り(幅50000×4本):", (50000*4).toLocaleString(), "ブロック");
console.log("1日あたり:", (50000*4*6*24).toLocaleString(), "ブロック");
console.log("base 残り約4,920万ブロック →", (49200000/(50000*4*6*24)).toFixed(1), "日");
