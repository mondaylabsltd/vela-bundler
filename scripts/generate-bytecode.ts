/**
 * Reads EntryPointSimulations bytecode from .txt file and generates
 * a TypeScript module with an inlined string constant.
 *
 * Usage: deno task generate-bytecode
 */

const bytecode = (await Deno.readTextFile("shared/contracts/EntryPointSimulations_v07_bytecode.txt")).trim();

const content = `// AUTO-GENERATED — run: deno task generate-bytecode
export const ENTRY_POINT_SIMULATIONS_BYTECODE = "${bytecode}" as \`0x\${string}\`;
`;

await Deno.writeTextFile("shared/contracts/entrypoint-bytecode.ts", content);
console.log(`[generate-bytecode] Written ${content.length} bytes to shared/contracts/entrypoint-bytecode.ts`);
