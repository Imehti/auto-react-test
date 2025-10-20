import path from "path";
import { analyzeComponent } from "../src/utils/analyzeComponent";
import { generateTestFile } from "../src/generateTest";

// Get component path from CLI arguments
const inputPath = process.argv[2];

if (!inputPath) {
  console.error("❌ Please provide a component path, e.g.:\n  npx ts-node scripts/run-generator.ts src/Counter.tsx");
  process.exit(1);
}

const filePath = path.resolve(process.cwd(), inputPath);

console.log(`\n🧩 Analyzing component: ${filePath}\n`);

try {
  const analyzed = analyzeComponent(filePath);
  console.log("✅ ANALYZED RESULT:");
  console.dir(analyzed, { depth: null });

  generateTestFile(filePath, analyzed);
  console.log("\n🎉 Done! Test file generated successfully.\n");
} catch (err) {
  console.error("❌ Error analyzing or generating test file:", err);
  process.exit(1);
}
