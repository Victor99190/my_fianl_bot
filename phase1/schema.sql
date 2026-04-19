-- ============================================================
-- Nepal Political News Bot — Phase 1 Supabase Schema
-- Run this in Supabase SQL Editor before running the pipeline
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Context Chunks ────────────────────────────────────────────────────────────
-- Core knowledge base. All modules write here.
-- Phase 2 will populate the embedding column.

CREATE TABLE IF NOT EXISTS context_chunks (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Content
    content           TEXT         NOT NULL,
    content_hash      VARCHAR(64)  UNIQUE NOT NULL,  -- SHA-256 for deduplication
    chunk_index       INTEGER      NOT NULL,
    chunk_size_chars  INTEGER      NOT NULL,

    -- Classification
    entity_type       VARCHAR(50)  NOT NULL,  -- politician | party | law | history | foreign_affairs
    entity_name       VARCHAR(255) NOT NULL,  -- e.g. "KP Sharma Oli", "Constitution of Nepal 2015 — Article 18"

    -- Source
    source            VARCHAR(50)  NOT NULL,  -- wikipedia | official_pdf | curated_static | bot_scraped
    source_url        TEXT,
    date_published    DATE,

    -- Trust tier
    verified          BOOLEAN      NOT NULL DEFAULT FALSE,  -- TRUE = Tier 1 ground truth (your uploads only)

    -- Freshness
    last_verified     DATE         NOT NULL DEFAULT CURRENT_DATE,
    needs_review      BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Legal document fields (law entity_type only)
    amendment_status  VARCHAR(20),        -- active | repealed | superseded
    valid_from_date   DATE,
    superseded_by     UUID REFERENCES context_chunks(id),

    -- Phase 2 — populated during embedding generation
    embedding         vector(768)  DEFAULT NULL,

    created_at        TIMESTAMPTZ  DEFAULT timezone('utc', now())
);

-- ── Politicians ───────────────────────────────────────────────────────────────
-- Structured infobox data for fast relational lookup.
-- Populated from MediaWiki infobox extraction.

CREATE TABLE IF NOT EXISTS politicians (
    id                       UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                     VARCHAR(255) NOT NULL UNIQUE,
    role                     VARCHAR(255),                    -- current office
    party                    VARCHAR(255),
    electoral_constituency   VARCHAR(255),
    birth_date               DATE,
    infobox_raw              JSONB,                           -- full parsed infobox
    last_verified            DATE         NOT NULL DEFAULT CURRENT_DATE,
    needs_review             BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ  DEFAULT timezone('utc', now())
);

-- ── Terminology ───────────────────────────────────────────────────────────────
-- Political glossary with Nepali translations.

CREATE TABLE IF NOT EXISTS terminology (
    id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    term_english     VARCHAR(255) NOT NULL,
    term_nepali      VARCHAR(255),
    definition       TEXT,
    political_context TEXT,
    created_at       TIMESTAMPTZ  DEFAULT timezone('utc', now())
);

-- ── Posted Articles ───────────────────────────────────────────────────────────
-- Bot deduplication — prevents reposting the same article.

CREATE TABLE IF NOT EXISTS posted_articles (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_url  TEXT        UNIQUE NOT NULL,
    headline     TEXT,
    fb_post_id   TEXT,
    posted_at    TIMESTAMPTZ DEFAULT timezone('utc', now())
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Fast pre-filter before vector search (entity_type + entity_name)
CREATE INDEX IF NOT EXISTS idx_chunks_entity
    ON context_chunks(entity_type, entity_name);

-- Fast deduplication lookup
CREATE INDEX IF NOT EXISTS idx_chunks_hash
    ON context_chunks(content_hash);

-- Fast stale record queries (freshness flag sweep)
CREATE INDEX IF NOT EXISTS idx_chunks_freshness
    ON context_chunks(last_verified, needs_review);

-- Fast verified-only lookups (Tier 1 ground truth queries)
CREATE INDEX IF NOT EXISTS idx_chunks_verified
    ON context_chunks(verified);

-- Fast amendment filtering for legal documents
CREATE INDEX IF NOT EXISTS idx_chunks_amendment
    ON context_chunks(amendment_status)
    WHERE entity_type = 'law';

-- Politician name lookup
CREATE INDEX IF NOT EXISTS idx_politicians_name
    ON politicians(name);

-- ── pgvector Similarity Search Function ──────────────────────────────────────
-- Used in Phase 3 RAG query logic.
-- Pre-filters by entity_type and verified flag before running vector search.

CREATE OR REPLACE FUNCTION match_context(
    query_embedding  vector(768),
    filter_type      TEXT    DEFAULT NULL,   -- e.g. 'politician', 'law'
    verified_only    BOOLEAN DEFAULT FALSE,
    match_threshold  FLOAT   DEFAULT 0.7,
    match_count      INT     DEFAULT 5
)
RETURNS TABLE (
    id          UUID,
    entity_type TEXT,
    entity_name TEXT,
    content     TEXT,
    verified    BOOLEAN,
    similarity  FLOAT
)
LANGUAGE sql STABLE AS $$
    SELECT
        id,
        entity_type,
        entity_name,
        content,
        verified,
        1 - (embedding <=> query_embedding) AS similarity
    FROM context_chunks
    WHERE
        embedding IS NOT NULL
        AND (filter_type IS NULL OR entity_type = filter_type)
        AND (verified_only = FALSE OR verified = TRUE)
        AND amendment_status IS DISTINCT FROM 'repealed'
        AND amendment_status IS DISTINCT FROM 'superseded'
        AND 1 - (embedding <=> query_embedding) > match_threshold
    ORDER BY embedding <=> query_embedding
    LIMIT match_count;
$$;
