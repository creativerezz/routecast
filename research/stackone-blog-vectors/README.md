# StackOne Blog Vector Corpus

Local vectorized corpus of StackOne blog posts plus `llms.txt` for Routecast
product research.

Generated with:

```bash
node scripts/vectorize-stackone-blogs.mjs
```

Search with:

```bash
node scripts/search-stackone-blog-vectors.mjs "schema bloat response bloat tool discovery"
```

Generate OpenAI dense embeddings with:

```bash
node scripts/embed-stackone-blogs-openai.mjs
```

The embedding script reads `OPENAI_API_KEY` if present. If not, it falls back to
the local OpenClaw `openai:default` auth profile and never writes the key into
the repo.

Files:

- `manifest.json` - corpus metadata
- `posts.jsonl` - one cleaned full-text record per blog post
- `chunks.jsonl` - chunk metadata and chunk text
- `vectors.jsonl` - sparse hashed-TF-IDF vectors keyed to chunks
- `openai-manifest.json` - dense embedding metadata, when generated
- `openai-vectors.jsonl` - dense OpenAI embeddings keyed to chunks, when generated

The `stackone-llms` record comes from `https://www.stackone.com/llms.txt` and
captures StackOne's LLM-facing sitemap, product claims, connector/action counts,
changelog links, and blog index.

The sparse index is dependency-free and does not require a hosted embeddings API.
When `openai-vectors.jsonl` exists, the search script uses dense OpenAI
embeddings by default. Pass `--sparse` to force the local hashed-TF-IDF index.
