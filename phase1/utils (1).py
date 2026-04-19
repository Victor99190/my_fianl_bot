import hashlib
import re
from typing import List


# ── Hashing ───────────────────────────────────────────────────────────────────

def generate_hash(text: str) -> str:
    """SHA-256 fingerprint for deduplication. Strips whitespace before hashing
    so minor formatting changes don't create false new entries."""
    normalized = " ".join(text.split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ── Text Cleaning ─────────────────────────────────────────────────────────────

def clean_wiki_text(text: str) -> str:
    """
    Remove Wikipedia artifacts from plain-text extract:
    - Citation brackets like [12], [note 3]
    - Section header lines that are just titles (== History ==)
    - Excessive blank lines
    - Edit section markers
    """
    # Remove citation brackets e.g. [1], [12], [note 3], [a]
    text = re.sub(r'\[\d+\]', '', text)
    text = re.sub(r'\[note \d+\]', '', text)
    text = re.sub(r'\[[a-z]\]', '', text)

    # Remove Wikipedia section markers (== Title ==, === Title ===)
    text = re.sub(r'={2,}.*?={2,}', '', text)

    # Remove lines that are purely navigation/template artifacts
    lines = text.splitlines()
    cleaned_lines = []
    for line in lines:
        stripped = line.strip()
        # Skip empty section headers, "See also", "References" etc.
        if stripped.lower() in ("see also", "references", "external links",
                                "notes", "bibliography", "further reading",
                                "sources", "footnotes"):
            continue
        cleaned_lines.append(line)

    # Collapse 3+ blank lines into 2
    text = "\n".join(cleaned_lines)
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


# ── Chunking ──────────────────────────────────────────────────────────────────

def semantic_chunk_text(text: str, max_chars: int = 1500, overlap: int = 300) -> List[str]:
    """
    Recursive semantic splitting: Paragraph → Sentence → Character fallback.
    Applies proper character-level overlap between chunks so no context
    is lost at boundaries.

    Why characters not words:
        LLMs process tokens (~4 chars each). 1500 chars ≈ 400 tokens,
        safely within Gemini's context window.
    """
    if not text or not text.strip():
        return []

    if len(text) <= max_chars:
        return [text.strip()]

    raw_chunks = _split_recursive(text, max_chars)

    # Apply overlap: prepend tail of previous chunk to current chunk
    final_chunks = []
    for i, chunk in enumerate(raw_chunks):
        if i > 0:
            prev_tail = raw_chunks[i - 1][-overlap:]
            chunk = prev_tail + " " + chunk
            # Re-trim to max_chars if overlap pushed it over
            if len(chunk) > max_chars:
                chunk = chunk[:max_chars]
        final_chunks.append(chunk.strip())

    return [c for c in final_chunks if len(c) > 60]  # drop micro-fragments


def _split_recursive(text: str, max_chars: int) -> List[str]:
    """Internal recursive splitter. Returns chunks WITHOUT overlap applied."""
    if len(text) <= max_chars:
        return [text.strip()]

    chunks = []

    # Level 1: Try paragraph boundaries
    paragraphs = text.split("\n\n")
    if len(paragraphs) > 1:
        current = ""
        for para in paragraphs:
            if len(current) + len(para) + 2 <= max_chars:
                current += para + "\n\n"
            else:
                if current.strip():
                    chunks.append(current.strip())
                # Single paragraph too big → recurse
                if len(para) > max_chars:
                    chunks.extend(_split_recursive(para, max_chars))
                    current = ""
                else:
                    current = para + "\n\n"
        if current.strip():
            chunks.append(current.strip())
        return chunks

    # Level 2: Try sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) > 1:
        current = ""
        for sent in sentences:
            if len(current) + len(sent) + 1 <= max_chars:
                current += sent + " "
            else:
                if current.strip():
                    chunks.append(current.strip())
                if len(sent) > max_chars:
                    chunks.extend(_split_recursive(sent, max_chars))
                    current = ""
                else:
                    current = sent + " "
        if current.strip():
            chunks.append(current.strip())
        return chunks

    # Level 3: Hard character cut (last resort)
    for i in range(0, len(text), max_chars):
        chunks.append(text[i: i + max_chars].strip())
    return chunks


# ── Legal Document Chunking ───────────────────────────────────────────────────

def chunk_legal_text(text: str, max_chars: int = 1500, overlap: int = 300) -> List[dict]:
    """
    Article/Section-aware chunking for legal documents (Constitution, Acts).

    Returns list of dicts with:
        - content: chunk text
        - article_ref: detected article/section number (e.g. "Article 18")

    Splits on article/section headings first, falls back to semantic_chunk_text
    within each article if the article itself is too long.
    """
    # Match patterns like: "Article 18", "Section 3", "Part IV", "Schedule 1"
    article_pattern = re.compile(
        r'(?=\b(Article|Section|Part|Schedule|Chapter)\s+[\dIVXivx]+\b)',
        re.IGNORECASE
    )

    splits = article_pattern.split(text)

    # article_pattern.split returns alternating [before, keyword, rest, keyword, rest ...]
    # Reassemble into clean article blocks
    articles = []
    i = 0
    while i < len(splits):
        segment = splits[i].strip()
        if segment and len(segment) > 30:
            articles.append(segment)
        i += 1

    if not articles:
        # No article structure found — fall back to semantic chunking
        chunks = semantic_chunk_text(text, max_chars, overlap)
        return [{"content": c, "article_ref": None} for c in chunks]

    result = []
    for article_block in articles:
        # Extract article reference from first line
        first_line = article_block.splitlines()[0].strip()
        ref_match = re.match(
            r'(Article|Section|Part|Schedule|Chapter)\s+[\dIVXivx]+',
            first_line,
            re.IGNORECASE
        )
        article_ref = ref_match.group(0) if ref_match else None

        if len(article_block) <= max_chars:
            result.append({"content": article_block, "article_ref": article_ref})
        else:
            # Article too long — split semantically within it
            sub_chunks = semantic_chunk_text(article_block, max_chars, overlap)
            for sc in sub_chunks:
                result.append({"content": sc, "article_ref": article_ref})

    return [r for r in result if len(r["content"]) > 60]
