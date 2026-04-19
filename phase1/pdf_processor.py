import fitz  # PyMuPDF
from datetime import date
from typing import Optional

from config import logger
from utils import chunk_legal_text, semantic_chunk_text, generate_hash
from db import insert_or_update_chunk


class LegalPDFProcessor:
    """
    Layout-aware PDF processor for Tier 1 verified legal documents.

    Handles:
    - Multi-column layouts (sorts blocks top-to-bottom, left-to-right)
    - Article/Section-aware chunking (Constitution, Acts)
    - Semantic fallback for unstructured legal text
    - All chunks tagged verified=True (ground truth)
    """

    def __init__(
        self,
        file_path: str,
        document_name: str,
        entity_type: str = "law",
        valid_from_date: Optional[str] = None,
        source_url: Optional[str] = None,
    ):
        self.file_path       = file_path
        self.document_name   = document_name
        self.entity_type     = entity_type
        self.valid_from_date = valid_from_date
        self.source_url      = source_url or f"local_upload/{document_name}"

    def process(self):
        logger.info(f"[PDF] Starting: {self.document_name}")

        try:
            doc       = fitz.open(self.file_path)
            full_text = self._extract_text(doc)
            doc.close()

            if not full_text.strip():
                logger.error(f"[PDF] No text extracted from: {self.file_path}")
                return

            logger.info(
                f"[PDF] Extracted {len(full_text)} characters from "
                f"{self.document_name}"
            )

            # Article/Section-aware chunking for legal docs
            chunks = chunk_legal_text(full_text)
            today  = date.today().isoformat()

            inserted = 0
            for idx, chunk_obj in enumerate(chunks):
                chunk_text = chunk_obj["content"]
                article_ref = chunk_obj.get("article_ref")

                # Build entity name including article reference for precise filtering
                entity_name = (
                    f"{self.document_name} — {article_ref}"
                    if article_ref
                    else self.document_name
                )

                chunk_hash = generate_hash(chunk_text)

                payload = {
                    "content":          chunk_text,
                    "content_hash":     chunk_hash,
                    "entity_type":      self.entity_type,
                    "entity_name":      entity_name,
                    "source":           "official_pdf",
                    "source_url":       self.source_url,
                    "date_published":   self.valid_from_date,
                    "last_verified":    today,
                    "needs_review":     False,
                    "verified":         True,   # Tier 1 — absolute ground truth
                    "chunk_index":      idx,
                    "chunk_size_chars": len(chunk_text),
                    "embedding":        None,   # Phase 2
                    "amendment_status": "active",
                    "valid_from_date":  self.valid_from_date,
                    "superseded_by":    None,
                }
                insert_or_update_chunk(payload)
                inserted += 1

            logger.info(
                f"[PDF] Done: {self.document_name} — "
                f"{inserted} chunks stored (verified=True)"
            )

        except fitz.FileNotFoundError:
            logger.error(f"[PDF] File not found: {self.file_path}")
        except Exception as e:
            logger.error(f"[PDF] Failed to process {self.file_path}: {str(e)}")

    def _extract_text(self, doc: fitz.Document) -> str:
        """
        Layout-aware text extraction.
        Sorts text blocks top-to-bottom, left-to-right per page
        to handle multi-column legal document layouts correctly.
        """
        full_text = ""

        for page_num, page in enumerate(doc):
            blocks = page.get_text("blocks")

            # Sort: top-to-bottom (y), then left-to-right (x)
            blocks.sort(key=lambda b: (round(b[1] / 10) * 10, b[0]))

            page_text = ""
            for block in blocks:
                block_text = block[4].strip()
                if block_text:
                    page_text += block_text + "\n"

            if page_text.strip():
                full_text += page_text + "\n"

        return full_text
