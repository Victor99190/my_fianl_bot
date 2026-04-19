import os
import logging
from dotenv import load_dotenv

load_dotenv()

# ── Supabase ────────────────────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# ── Chunking ─────────────────────────────────────────────────────────────────
CHUNK_SIZE    = 1500   # characters (~400 tokens — safe for Gemini context window)
CHUNK_OVERLAP = 300    # characters

# ── Wikipedia API ─────────────────────────────────────────────────────────────
WIKI_REQUEST_DELAY  = 1.5   # seconds between every request
WIKI_RETRY_DELAYS   = [5, 10]  # exponential backoff on failure
WIKI_USER_AGENT     = "NepalPoliticalRAGBot/2.0 (pawn.khanal11@gmail.com)"

# ── Freshness ─────────────────────────────────────────────────────────────────
REVIEW_AFTER_DAYS = 90   # flag needs_review after this many days

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("failed_fetches.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("Phase1_Pipeline")
