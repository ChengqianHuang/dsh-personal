# Agent Note: Connection-local full-text retrieval

Status: implemented

## Problem

Whole-string LIKE queries miss separated Chinese keywords, rank rows only by date, and return independent type groups whose limits do not form a global top result set. Existing v4 rows need better retrieval without replacing the user's data file.

## Decision

`src/store/search.ts` owns a TEMP FTS5 index on each personal database connection. Jieba search-mode segmentation indexes Chinese compound subwords; ordinary segmentation builds literal AND or OR query terms. User text cannot supply FTS operators. BM25 uses configurable title, tag, and body weights and one global cap. Search results contain the segmented terms and globally ranked complete domain rows.

TEMP insert, update, and delete triggers maintain the index and its JSON row projections in the transaction that changes the durable record. Search pins a main-database read snapshot before checking that connection's `data_version`. External commits cause a full rebuild in that snapshot; the version is remembered only after commit, so failed rebuilds can retry. SQLite TEMP storage stays in memory. Opening a connection installs the index, and closing it drops all related objects. The durable schema remains v4.

## Alternatives considered

**Segmented LIKE with custom scoring** still scans record text for each term and requires an owned scoring algorithm. FTS5 supplies an inverted index and BM25 instead.

**A persistent index in the personal file** adds durable format and tokenizer-version responsibilities for data that is fully derivable. The current single-user scale permits rebuilding, so index persistence is deferred until measurements show startup or external-write rebuild costs are material.

**SQLite unicode61 alone or Intl.Segmenter alone** does not provide the chosen Chinese retrieval vocabulary. unicode61 treats a contiguous Chinese phrase as one token, while the host's ICU segmentation splits the example 博客 into two characters. Jieba supplies words and compound subwords consistently through its bundled dictionary.

**Vector retrieval** adds an embedding provider, model versions, latency, and another consistency problem. The present requirement is keyword recall and ranking; synonym expansion remains an explicit model rephrasing step.

## Consequences

v4 data remains usable, other SQLite clients can still write independently, and local mutations and rollbacks cannot leave stale search rows. Other-process writes and cold starts require scanning all searchable rows. Index memory duplicates text and row projections; this cost is appropriate for the current personal workload, not an unlimited archive. Search is lexical and does not promise arbitrary substrings or semantic equivalence. Callers consume ordered hits rather than type groups; score comparisons apply only within one query.

The query corpus, update/delete/rollback tests, two-connection refresh, restart, ranked tool-output snapshot, Loader composition, and real-provider cold-start search cover these obligations.
