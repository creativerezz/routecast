# StackOne Blog Vector Corpus

Local vectorized corpus of StackOne blog posts for Routecast product research.

Generated with:

```bash
node scripts/vectorize-stackone-blogs.mjs
```

Search with:

```bash
node scripts/search-stackone-blog-vectors.mjs "schema bloat response bloat tool discovery"
```

Files:

- `manifest.json` - corpus metadata
- `posts.jsonl` - one cleaned full-text record per blog post
- `chunks.jsonl` - chunk metadata and chunk text
- `vectors.jsonl` - sparse hashed-TF-IDF vectors keyed to chunks

This is dependency-free and does not require a hosted embeddings API. It is good enough for local retrieval and product research. For production semantic search, replace `vectors.jsonl` with dense embeddings while keeping the same chunk ids.
