// scripts/compile-contract.js
//
// テストネット用・本番用の両方のデプロイスクリプトから共通で使う
// コンパイル処理。重複を避けるためにここへ切り出している。

import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/// name は contracts/ の中のファイル名(拡張子なし)= コントラクト名。
/// 既定は裁定の DexArbFlashLoan。清算は "AaveLiquidator"。
export function compileContract(name = "DexArbFlashLoan") {
  const contractPath = path.join(__dirname, "..", "contracts", `${name}.sol`);
  const source = fs.readFileSync(contractPath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      [`${name}.sol`]: { content: source },
    },
    settings: {
      // [ガス削減版(2026年9月20日)]
      // runs は展開サイズより実行時のガスを優先する値にする(2段で約1,300ガス減。
      // 展開サイズは +3.5KB、展開費は一度きりで約$0.04)。
      // evmVersion はコントラクトが一時記憶(EIP-1153)を使うため cancun を明示する。
      // 稼働4チェーンとも対応済み: Polygon / Optimism は現行版に既に Cancun の
      // MCOPY が含まれ本番で動いている。Avalanche は Etna(2024年12月、ACP-131)、
      // Arbitrum は ArbOS 20 で TSTORE/TLOAD に対応。
      optimizer: { enabled: true, runs: 1000000 },
      evmVersion: "cancun",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    console.error("[コンパイル] エラー:");
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("コンパイル失敗");
  }
  const warnings = (output.errors || []).filter((e) => e.severity === "warning");
  for (const w of warnings) console.warn("[コンパイル] 警告:", w.formattedMessage);

  const compiled = output.contracts[`${name}.sol`][name];
  return { abi: compiled.abi, bytecode: "0x" + compiled.evm.bytecode.object };
}
