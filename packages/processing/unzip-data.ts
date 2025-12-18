// Recursively extracts all .zip files in data/
// Usage: bun run unzip-data.ts
//
// Handles nested zips (e.g., yearly archives containing monthly zips)
// by looping until no more zip files are found.

import { exec } from "child_process";
import { readdir, rm, stat } from "node:fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { dataDir } from "./utils";

const execAsync = promisify(exec);
const CONCURRENCY = os.cpus().length;

// Clean up macOS metadata directories and files recursively
async function cleanupMacOSMetadata(dir: string): Promise<number> {
  let removed = 0;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Remove __MACOSX directories
      if (entry.name === "__MACOSX" && entry.isDirectory()) {
        await rm(fullPath, { recursive: true, force: true });
        removed++;
        continue;
      }

      // Remove ._ files (macOS resource forks)
      if (entry.name.startsWith("._") && entry.isFile()) {
        await rm(fullPath, { force: true });
        removed++;
        continue;
      }

      // Recurse into subdirectories
      if (entry.isDirectory()) {
        removed += await cleanupMacOSMetadata(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or not accessible
  }

  return removed;
}

async function findZipFiles(dir: string): Promise<string[]> {
  const zips: string[] = [];

  // Check if directory exists
  try {
    const dirStat = await stat(dir);
    if (!dirStat.isDirectory()) {
      return zips;
    }
  } catch {
    return zips;
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Skip macOS metadata directories and files
    if (entry.name === "__MACOSX" || entry.name.startsWith("._")) {
      continue;
    }
    if (entry.isDirectory()) {
      zips.push(...(await findZipFiles(fullPath)));
    } else if (entry.name.endsWith(".zip")) {
      zips.push(fullPath);
    }
  }
  return zips;
}

async function unzipFile(zipPath: string): Promise<void> {
  const dir = path.dirname(zipPath);
  console.log(`  Extracting: ${path.basename(zipPath)}`);
  try {
    await execAsync(`unzip -o -q "${zipPath}" -d "${dir}"`);
  } catch (err) {
    console.error(`  Failed to extract ${zipPath}: ${err}`);
  }
}

async function unzipAll(zips: string[]): Promise<void> {
  let index = 0;

  async function worker(): Promise<void> {
    while (index < zips.length) {
      const currentIndex = index++;
      await unzipFile(zips[currentIndex]!);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

async function main() {
  console.log(`Scanning for .zip files in ${dataDir}...`);

  // Check if data directory exists
  try {
    const dirStat = await stat(dataDir);
    if (!dirStat.isDirectory()) {
      console.error(`Data directory not found: ${dataDir}`);
      console.error(`Create it and add your .zip files there.`);
      process.exit(1);
    }
  } catch {
    console.error(`Data directory not found: ${dataDir}`);
    console.error(`Create it and add your .zip files there.`);
    process.exit(1);
  }

  // Keep extracting until no new zips found (handles nested zips)
  let iteration = 0;
  let totalExtracted = 0;
  const processedZips = new Set<string>();

  while (true) {
    const allZips = await findZipFiles(dataDir);
    const zips = allZips.filter((z) => !processedZips.has(z));
    if (zips.length === 0) break;

    iteration++;
    console.log(`\nPass ${iteration}: Found ${zips.length} new zip file(s) (concurrency: ${CONCURRENCY})`);

    await unzipAll(zips);
    for (const zip of zips) {
      processedZips.add(zip);
    }
    totalExtracted += zips.length;
  }

  if (totalExtracted === 0) {
    console.log("\nNo zip files found.");
  } else {
    console.log(`\nDone. Extracted ${totalExtracted} zip file(s) in ${iteration} pass(es).`);
  }

  // Clean up macOS metadata files
  console.log("\nCleaning up macOS metadata...");
  const removedCount = await cleanupMacOSMetadata(dataDir);
  if (removedCount > 0) {
    console.log(`  Removed ${removedCount} __MACOSX directories and ._ files`);
  } else {
    console.log("  No macOS metadata found");
  }
}

main();
