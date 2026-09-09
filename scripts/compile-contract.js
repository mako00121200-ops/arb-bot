// scripts/compile-contract.js
//
// テストネット用・本番用の両方のデプロイスクリプトから共通で使う
// コンパイル処理。重複を避けるためにここへ切り出している。

import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function compileContract() {
  const contractPath = path.join(__dirname, "..", "contracts", "DexArbFlashLoan.sol");
  const source = fs.readFileSync(contractPath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      "DexArbFlashLoan.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
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

  const compiled = output.contracts["DexArbFlashLoan.sol"]["DexArbFlashLoan"];
  return { abi: compiled.abi, bytecode: "0x" + compiled.evm.bytecode.object };
}
