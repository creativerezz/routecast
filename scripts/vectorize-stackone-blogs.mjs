#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BLOG_URL = "https://www.stackone.com/blog/";
const LLMS_URL = "https://www.stackone.com/llms.txt";
const LLMS_FULL_URL = "https://www.stackone.com/llms-full.txt";
const OUT_DIR = path.resolve("research/stackone-blog-vectors");
const DIMENSIONS = 4096;
const CHUNK_WORDS = 700;
const OVERLAP_WORDS = 120;

const stopwords = new Set(
  [
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "i",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "their",
    "this",
    "to",
    "was",
    "we",
    "when",
    "with",
    "you",
    "your",
  ]
    .join(" ")
    .split(/\s+/),
);

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function titleFromHtml(html, fallback) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).replace(/\s+\|\s+StackOne$/i, "");
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title?.[1]) return decodeEntities(title[1]).replace(/\s+\|\s+StackOne$/i, "");
  return fallback;
}

function descriptionFromHtml(html) {
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return meta?.[1] ? decodeEntities(meta[1]) : "";
}

function postUrlsFromIndex(html) {
  const urls = new Set();
  for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
    const href = match[1];
    if (!href || href === "/blog/" || href === "https://www.stackone.com/blog/") continue;
    const absolute = new URL(href, BLOG_URL).toString();
    const url = new URL(absolute);
    if (url.hostname !== "www.stackone.com") continue;
    if (!url.pathname.startsWith("/blog/")) continue;
    if (url.pathname.split("/").filter(Boolean).length !== 2) continue;
    urls.add(`${url.origin}${url.pathname}`);
  }
  return [...urls].sort();
}

function cleanPostText(text) {
  const seen = new Set();
  const skip =
    /^(platform|connect|optimize|secure|solutions|resources|developers|learn|pricing|login|book demo|start free|all agents|mcp|announcements|ai research|ai safety|engineering|using stackone|industry takes|was this page helpful\?|yes no|© 2026 stackone|table of contents)$/i;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 1 && !skip.test(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

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

function makeChunks(post) {
  const words = post.text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - OVERLAP_WORDS) {
    const chunkWords = words.slice(start, start + CHUNK_WORDS);
    if (chunkWords.length < 80) break;
    chunks.push({
      id: `${post.slug}#${chunks.length + 1}`,
      postSlug: post.slug,
      title: post.title,
      url: post.url,
      chunkIndex: chunks.length,
      text: chunkWords.join(" "),
    });
  }
  return chunks;
}

async function llmsPost(url, slug, title, description) {
  const text = await fetchText(url);
  return {
    slug,
    url,
    title,
    description,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    text,
  };
}

function vectorize(chunks) {
  const docs = chunks.map((chunk) => tokenize(`${chunk.title} ${chunk.text}`));
  const dfs = new Map();
  for (const tokens of docs) {
    for (const idx of new Set(tokens.map(hashToken))) dfs.set(idx, (dfs.get(idx) ?? 0) + 1);
  }
  const n = docs.length;
  return docs.map((tokens) => {
    const counts = new Map();
    for (const token of tokens) {
      const idx = hashToken(token);
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    const weighted = [...counts.entries()].map(([idx, count]) => {
      const idf = Math.log((1 + n) / (1 + (dfs.get(idx) ?? 0))) + 1;
      return [idx, (1 + Math.log(count)) * idf];
    });
    const norm = Math.hypot(...weighted.map(([, value]) => value)) || 1;
    return weighted
      .map(([idx, value]) => [idx, Number((value / norm).toFixed(6))])
      .sort((a, b) => a[0] - b[0]);
  });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "routecast-research/0.1 (+https://github.com/creativerezz/routecast)",
    },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const indexHtml = await fetchText(BLOG_URL);
  const urls = postUrlsFromIndex(indexHtml);
  console.error(`found ${urls.length} StackOne blog posts`);

  const posts = [];
  for (const [i, url] of urls.entries()) {
    const html = await fetchText(url);
    const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    const text = cleanPostText(stripHtml(html));
    const post = {
      slug,
      url,
      title: titleFromHtml(html, slug),
      description: descriptionFromHtml(html),
      wordCount: text.split(/\s+/).filter(Boolean).length,
      text,
    };
    if (post.wordCount >= 100) posts.push(post);
    console.error(
      `${String(i + 1).padStart(2, "0")}/${urls.length} ${post.slug} (${post.wordCount} words)`,
    );
  }
  const llmsSources = [
    await llmsPost(
      LLMS_URL,
      "stackone-llms",
      "StackOne llms.txt",
      "StackOne's LLM-facing product, connector, changelog, and content map.",
    ),
    await llmsPost(
      LLMS_FULL_URL,
      "stackone-llms-full",
      "StackOne llms-full.txt",
      "Full StackOne site content for LLM consumption.",
    ),
  ];
  posts.push(...llmsSources);
  for (const source of llmsSources) {
    console.error(`${source.slug} (${source.wordCount} words)`);
  }

  const chunks = posts.flatMap(makeChunks);
  const vectors = vectorize(chunks);
  const generatedAt = new Date().toISOString();

  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt,
        source: BLOG_URL,
        extraSources: [LLMS_URL, LLMS_FULL_URL],
        posts: posts.length,
        chunks: chunks.length,
        dimensions: DIMENSIONS,
        vectorizer: "hashed-tfidf",
        chunkWords: CHUNK_WORDS,
        overlapWords: OVERLAP_WORDS,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "posts.jsonl"),
    `${posts.map((post) => JSON.stringify(post)).join("\n")}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "chunks.jsonl"),
    `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "vectors.jsonl"),
    `${chunks
      .map((chunk, i) =>
        JSON.stringify({
          id: chunk.id,
          url: chunk.url,
          title: chunk.title,
          vector: vectors[i],
        }),
      )
      .join("\n")}\n`,
  );
  console.error(`wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
