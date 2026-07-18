/**
 * Reads EntryPointSimulations bytecode from .txt file and generates
 * a TypeScript module with an inlined string constant.
 *
 * Usage: npm run generate-bytecode
 */

import { readFileSync, writeFileSync } from "node:fs";

const bytecode = readFileSync("shared/contracts/EntryPointSimulations_v07_bytecode.txt", "utf8").trim();

const content = `// AUTO-GENERATED — run: npm run generate-bytecode
export const ENTRY_POINT_SIMULATIONS_BYTECODE = "${bytecode}" as \`0x\${string}\`;
`;

writeFileSync("shared/contracts/entrypoint-bytecode.ts", content);
console.log(`[generate-bytecode] Written ${content.length} bytes to shared/contracts/entrypoint-bytecode.ts`);
