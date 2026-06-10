#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const INDEX_DIR = path.resolve("research/stackone-blog-vectors");
const DIMENSIONS = 4096;
const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error("usage: node scripts/search-stackone-blog-vectors.mjs <query>");
  process.exit(1);
}

const stopwords = new Set(
  "a an and are as at be but by for from has have how in into is it its of on or our that the their this to was we when with you your"
    .split(/\s+/),
);

function tokenize(text) {
  return text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9+._-]{1,}/g)
    ?.filter((token) => !stopwords.has(token) && token.length < 60) ?? [];
}

function hashToken(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % DIMENSIONS;
}

function sparseQueryVector(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    const idx = hashToken(token);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  const weighted = [...counts.entries()].map(([idx, count]) => [idx, 1 + Math.log(count)]);
  const norm = Math.hypot(...weighted.map(([, value]) => value)) || 1;
  return new Map(weighted.map(([idx, value]) => [idx, value / norm]));
}

function dot(queryVector, docVector) {
  let score = 0;
  for (const [idx, value] of docVector) score += (queryVector.get(idx) ?? 0) * value;
  return score;
}

const chunks = (await readFile(path.join(INDEX_DIR, "chunks.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const vectors = (await readFile(path.join(INDEX_DIR, "vectors.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const qv = sparseQueryVector(query);
const scored = vectors
  .map((entry, i) => ({
    score: dot(qv, entry.vector),
    chunk: chunks[i],
  }))
  .filter((item) => item.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 8);

for (const { score, chunk } of scored) {
  const excerpt = chunk.text.replace(/\s+/g, " ").slice(0, 360);
  console.log(`\n${score.toFixed(3)}  ${chunk.title}`);
  console.log(`     ${chunk.url}`);
  console.log(`     ${excerpt}${chunk.text.length > 360 ? "..." : ""}`);
}
