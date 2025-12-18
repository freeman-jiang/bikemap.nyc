import { execSync } from "child_process";
import path from "path";

export const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
export const dataDir = path.join(gitRoot, "data");
export const csvGlob = path.join(dataDir, "**/*.csv");
export const outputDir = path.join(gitRoot, "packages/processing/output");

// NYC bounding box - filters out invalid/test stations
export const NYC_BOUNDS = {
  minLat: 40.3,
  maxLat: 41.2,
  minLng: -74.5,
  maxLng: -73.5,
};

export function formatHumanReadableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
