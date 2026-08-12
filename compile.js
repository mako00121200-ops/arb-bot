import fs from "fs";
import path from "path";
import solc from "solc";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function compileFlashArbitrage() {
  const source = fs.readFileSync(path.join(__dirname, "contracts", "FlashArbitrage.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "FlashArbitrage.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length) {
      throw new Error("Solidityコンパイルエラー:\n" + fatal.map((e) => e.formattedMessage).join("\n"));
    }
  }
  const contract = output.contracts["FlashArbitrage.sol"]["FlashArbitrage"];
  return {
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
  };
}
