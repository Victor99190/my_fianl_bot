from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_KEY, logger
from datetime import date, datetime


supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Core Insert / Update ──────────────────────────────────────────────────────

def insert_or_update_chunk(chunk_data: dict):
    """
    Native upsert on content_hash (unique column).

    - Hash already exists → updates last_verified + needs_review only.
      embedding column is NOT overwritten so Phase 2 vectors survive re-seeds.
    - Hash is new → fresh insert.

    Single DB call. No race condition.
    """
    try:
        payload = {
            **chunk_data,
            "last_verified": date.today().isoformat(),
            "needs_review":  False,
        }
        supabase.table("context_chunks").upsert(
            payload,
            on_conflict="content_hash",
            ignore_duplicates=False,
        ).execute()

        logger.info(
            f"[UPSERT] {chunk_data['entity_type'].upper()} | "
            f"{chunk_data['entity_name']} | chunk #{chunk_data['chunk_index']} | "
            f"{chunk_data['chunk_size_chars']} chars"
        )

    except Exception as e:
        logger.error(
            f"[DB ERROR] {chunk_data.get('entity_name', 'unknown')} "
            f"chunk #{chunk_data.get('chunk_index', '?')}: {str(e)}"
        )


def insert_or_update_politician(politician_data: dict):
    """
    Native upsert on name (unique column).
    Updates all infobox fields if politician already exists.
    Single DB call. No race condition.
    """
    try:
        payload = {
            **politician_data,
            "last_verified": date.today().isoformat(),
            "needs_review":  False,
        }
        supabase.table("politicians").upsert(
            payload,
            on_conflict="name",
            ignore_duplicates=False,
        ).execute()

        logger.info(f"[UPSERT] Politician: {politician_data['name']}")

    except Exception as e:
        logger.error(f"[DB ERROR] Politician {politician_data.get('name')}: {str(e)}")


def flag_stale_records():
    """
    Run periodically (e.g. weekly via GitHub Actions).
    Flags any record not verified in REVIEW_AFTER_DAYS as needs_review=True.
    """
    from config import REVIEW_AFTER_DAYS
    try:
        cutoff = date.today().replace(
            year=date.today().year,
            month=date.today().month,
            day=max(1, date.today().day - REVIEW_AFTER_DAYS),
        )
        result = (
            supabase.table("context_chunks")
            .update({"needs_review": True})
            .lt("last_verified", cutoff.isoformat())
            .eq("needs_review", False)
            .execute()
        )
        logger.info(f"[FRESHNESS] Flagged stale records older than {cutoff}")
    except Exception as e:
        logger.error(f"[FRESHNESS ERROR] {str(e)}")
