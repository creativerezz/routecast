#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INDEX_DIR = path.resolve("research/stackone-blog-vectors");
const DIMENSIONS = 4096;
const args = process.argv.slice(2);
const forceSparse = args.includes("--sparse");
const query = args
  .filter((arg) => arg !== "--sparse")
  .join(" ")
  .trim();
const OPENCLAW_AUTH_PROFILES = path.join(
  os.homedir(),
  ".openclaw/agents/main/agent/auth-profiles.json",
);

if (!query) {
  console.error("usage: node scripts/search-stackone-blog-vectors.mjs [--sparse] <query>");
  process.exit(1);
}

const stopwords = new Set(
  "a an and are as at be but by for from has have how in into is it its of on or our that the their this to was we when with you your".split(
    /\s+/,
  ),
);

function tokenize(text) {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+._-]{1,}/g)
      ?.filter((token) => !stopwords.has(token) && token.length < 60) ?? []
  );
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

function denseDot(a, b) {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

function normalize(vector) {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

async function maybeReadJsonl(file) {
  try {
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const profiles = JSON.parse(await readFile(OPENCLAW_AUTH_PROFILES, "utf8"));
  const profile = profiles.profiles?.["openai:default"];
  if (profile?.type === "api_key" && profile.key) return profile.key;

  throw new Error("OPENAI_API_KEY is not set and OpenClaw profile openai:default was not found");
}

async function embedQuery(model, input) {
  const apiKey = await openaiKey();
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI query embedding failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  return payload.data[0].embedding;
}

const chunks = (await readFile(path.join(INDEX_DIR, "chunks.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const openaiVectors = forceSparse
  ? null
  : await maybeReadJsonl(path.join(INDEX_DIR, "openai-vectors.jsonl"));

let results;
if (openaiVectors) {
  const manifest = JSON.parse(await readFile(path.join(INDEX_DIR, "openai-manifest.json"), "utf8"));
  const queryVector = normalize(await embedQuery(manifest.model, query));
  results = openaiVectors
    .map((entry, i) => ({
      score: denseDot(queryVector, normalize(entry.vector)),
      chunk: chunks[i],
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
} else {
  const vectors = (await readFile(path.join(INDEX_DIR, "vectors.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const qv = sparseQueryVector(query);
  results = vectors
    .map((entry, i) => ({
      score: dot(qv, entry.vector),
      chunk: chunks[i],
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

for (const { score, chunk } of results) {
  const excerpt = chunk.text.replace(/\s+/g, " ").slice(0, 360);
  console.log(`\n${score.toFixed(3)}  ${chunk.title}`);
  console.log(`     ${chunk.url}`);
  console.log(`     ${excerpt}${chunk.text.length > 360 ? "..." : ""}`);
}
