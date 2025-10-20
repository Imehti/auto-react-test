#!/usr/bin/env node
import path from "path";
import fs from "fs";
import { generateTestFile } from "../src/generateTest";
import { analyzeComponent } from "../src/utils/analyzeComponent";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("❌ Please provide a component path");
  process.exit(1);
}

const componentPath = path.resolve(args[0]);

let analyzed;
try {
  analyzed = analyzeComponent(componentPath);
} catch {
  analyzed = undefined; // optional, fallback handled in generateTestFile
}

generateTestFile(componentPath, analyzed);
