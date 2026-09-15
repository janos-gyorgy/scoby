// fake gate: green at baseline, red on the first check after "done", green after that
import fs from "node:fs";
const f = process.env.GATE_STATE;
const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
fs.writeFileSync(f, String(n + 1));
if (n === 1) { console.log("src/pages/Starter.tsx(12,9): error TS2339: Property 'is_starter_recipe' does not exist on type 'Recipe'."); process.exit(2); }
