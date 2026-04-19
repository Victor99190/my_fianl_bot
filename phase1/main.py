"""
Phase 1 — Data Collection Pipeline
====================================
Nepal Political News Bot — RAG Knowledge Base Builder

Run:
    python main.py                    # full pipeline (default)
    python main.py --all              # full pipeline (explicit)
    python main.py --politicians      # politicians only
    python main.py --parties          # parties only
    python main.py --history          # history only
    python main.py --foreign          # foreign affairs only
    python main.py --pdfs             # PDFs only (Tier 1 ground truth)
    python main.py --flag-stale       # flag stale records (90-day cycle)
    python main.py --politicians --parties   # combine multiple flags
    python main.py --help             # show all options
"""

import argparse
import time
from config import logger
from wiki_scraper import WikiScraper
from pdf_processor import LegalPDFProcessor
from db import flag_stale_records


# ── PDF Manifest ──────────────────────────────────────────────────────────────
# Place your PDFs in the ./data/ directory and register them here.
# valid_from_date: when the document became legally effective (YYYY-MM-DD)

PDF_DOCUMENTS = [
    {
        "path":            "./data/nepal_constitution_2015.pdf",
        "name":            "Constitution of Nepal 2015",
        "entity_type":     "law",
        "valid_from_date": "2015-09-20",
        "source_url":      "https://www.constituteproject.org/constitution/Nepal_2015",
    },
    # Add more PDFs here when ready:
    # {
    #     "path":            "./data/local_governance_act_2017.pdf",
    #     "name":            "Local Government Operation Act 2017",
    #     "entity_type":     "law",
    #     "valid_from_date": "2017-10-05",
    #     "source_url":      "https://www.mofaga.gov.np",
    # },
    # {
    #     "path":            "./data/election_results_2022.pdf",
    #     "name":            "Election Commission Results 2022",
    #     "entity_type":     "law",
    #     "valid_from_date": "2022-11-20",
    #     "source_url":      "https://www.election.gov.np",
    # },
]


# ── Pipeline Steps ────────────────────────────────────────────────────────────

def run_politicians():
    scraper = WikiScraper()
    scraper.seed_politicians()


def run_parties():
    scraper = WikiScraper()
    scraper.seed_parties()


def run_history():
    scraper = WikiScraper()
    scraper.seed_history()


def run_foreign_affairs():
    scraper = WikiScraper()
    scraper.seed_foreign_affairs()


def run_pdfs():
    if not PDF_DOCUMENTS:
        logger.info("[PDF] No PDF documents registered. Add them to PDF_DOCUMENTS in main.py")
        return

    for doc in PDF_DOCUMENTS:
        processor = LegalPDFProcessor(
            file_path       = doc["path"],
            document_name   = doc["name"],
            entity_type     = doc.get("entity_type", "law"),
            valid_from_date = doc.get("valid_from_date"),
            source_url      = doc.get("source_url"),
        )
        processor.process()


def run_full_pipeline():
    start = time.time()
    logger.info("=" * 60)
    logger.info("PHASE 1 — FULL DATA COLLECTION PIPELINE STARTING")
    logger.info("=" * 60)

    run_politicians()
    run_parties()
    run_history()
    run_foreign_affairs()
    run_pdfs()

    elapsed = round(time.time() - start, 1)
    logger.info("=" * 60)
    logger.info(f"PHASE 1 COMPLETE — {elapsed}s elapsed")
    logger.info("Next step: Phase 2 — Generate embeddings for all chunks")
    logger.info("=" * 60)


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nepal Political RAG — Phase 1 Data Collection Pipeline"
    )
    parser.add_argument("--politicians", action="store_true", help="Seed federal politicians")
    parser.add_argument("--parties",     action="store_true", help="Seed political parties")
    parser.add_argument("--history",     action="store_true", help="Seed historical context")
    parser.add_argument("--foreign",     action="store_true", help="Seed foreign affairs")
    parser.add_argument("--pdfs",        action="store_true", help="Process official PDFs (Tier 1)")
    parser.add_argument("--flag-stale",  action="store_true", help="Flag records older than 90 days")
    parser.add_argument("--all",         action="store_true", help="Run full pipeline (default)")

    args = parser.parse_args()

    # If no flags passed OR --all → run everything
    if args.all or not any(vars(args).values()):
        run_full_pipeline()
    else:
        if args.politicians: run_politicians()
        if args.parties:     run_parties()
        if args.history:     run_history()
        if args.foreign:     run_foreign_affairs()
        if args.pdfs:        run_pdfs()
        if args.flag_stale:
            logger.info("[FRESHNESS] Running stale record check...")
            flag_stale_records()
