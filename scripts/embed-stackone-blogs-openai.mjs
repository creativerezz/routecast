#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INDEX_DIR = path.resolve("research/stackone-blog-vectors");
const EMBEDDING_MODEL = process.env.ROUTECAST_EMBEDDING_MODEL ?? "text-embedding-3-small";
const BATCH_SIZE = Number(process.env.ROUTECAST_EMBEDDING_BATCH_SIZE ?? 24);
const OPENCLAW_AUTH_PROFILES = path.join(
  os.homedir(),
  ".openclaw/agents/main/agent/auth-profiles.json",
);

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const profiles = JSON.parse(await readFile(OPENCLAW_AUTH_PROFILES, "utf8"));
  const profile = profiles.profiles?.["openai:default"];
  if (profile?.type === "api_key" && profile.key) return profile.key;

  throw new Error("OPENAI_API_KEY is not set and OpenClaw profile openai:default was not found");
}

async function embedBatch(apiKey, inputs) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function main() {
  const chunks = await readJsonl(path.join(INDEX_DIR, "chunks.jsonl"));
  const apiKey = await openaiKey();
  const masked = `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`;
  console.error(`embedding ${chunks.length} chunks with ${EMBEDDING_MODEL} using ${masked}`);

  const rows = [];
  let dimensions = null;
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const inputs = batch.map((chunk) => `${chunk.title}\n\n${chunk.text}`);
    const embeddings = await embedBatch(apiKey, inputs);

    for (const [i, embedding] of embeddings.entries()) {
      dimensions ??= embedding.length;
      const chunk = batch[i];
      rows.push({
        id: chunk.id,
        url: chunk.url,
        title: chunk.title,
        vector: embedding.map((value) => Number(value.toFixed(7))),
      });
    }

    console.error(`embedded ${Math.min(start + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  await writeFile(
    path.join(INDEX_DIR, "openai-vectors.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeFile(
    path.join(INDEX_DIR, "openai-manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        chunks: chunks.length,
        dimensions,
        vectorizer: "openai",
        model: EMBEDDING_MODEL,
        sourceChunks: "chunks.jsonl",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
