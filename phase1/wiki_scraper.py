import requests
import time
import re
from typing import Optional, Tuple
from datetime import date

from config import (
    WIKI_REQUEST_DELAY,
    WIKI_RETRY_DELAYS,
    WIKI_USER_AGENT,
    logger,
)
from utils import clean_wiki_text, semantic_chunk_text, generate_hash
from db import insert_or_update_chunk, insert_or_update_politician


# ── Entity Manifests ──────────────────────────────────────────────────────────
# Add more names here as you expand. The bot will handle the rest automatically.

POLITICIANS = [
    # Current Federal Government
    ("KP Sharma Oli",           "politician", "https://en.wikipedia.org/wiki/K._P._Sharma_Oli"),
    ("Pushpa Kamal Dahal",      "politician", "https://en.wikipedia.org/wiki/Pushpa_Kamal_Dahal"),
    ("Sher Bahadur Deuba",      "politician", "https://en.wikipedia.org/wiki/Sher_Bahadur_Deuba"),
    ("Ram Chandra Paudel",      "politician", "https://en.wikipedia.org/wiki/Ram_Chandra_Paudel"),
    ("Madhav Kumar Nepal",      "politician", "https://en.wikipedia.org/wiki/Madhav_Kumar_Nepal"),
    ("Upendra Yadav",           "politician", "https://en.wikipedia.org/wiki/Upendra_Yadav"),
    ("Rabi Lamichhane",         "politician", "https://en.wikipedia.org/wiki/Rabi_Lamichhane"),
    ("Balen Shah",              "politician", "https://en.wikipedia.org/wiki/Balen_Shah"),
    ("Baburam Bhattarai",       "politician", "https://en.wikipedia.org/wiki/Baburam_Bhattarai"),
    ("Sushil Koirala",          "politician", "https://en.wikipedia.org/wiki/Sushil_Koirala"),
    ("Bidhya Devi Bhandari",    "politician", "https://en.wikipedia.org/wiki/Bidhya_Devi_Bhandari"),
    ("Girija Prasad Koirala",   "politician", "https://en.wikipedia.org/wiki/Girija_Prasad_Koirala"),
    ("Madan Bhandari",          "politician", "https://en.wikipedia.org/wiki/Madan_Bhandari"),
    ("BP Koirala",              "politician", "https://en.wikipedia.org/wiki/B._P._Koirala"),
    ("Man Mohan Adhikari",      "politician", "https://en.wikipedia.org/wiki/Man_Mohan_Adhikari"),
    ("Lokendra Bahadur Chand",  "politician", "https://en.wikipedia.org/wiki/Lokendra_Bahadur_Chand"),
    ("Surya Bahadur Thapa",     "politician", "https://en.wikipedia.org/wiki/Surya_Bahadur_Thapa"),
    ("Rajendra Mahato",         "politician", "https://en.wikipedia.org/wiki/Rajendra_Mahato"),
    ("Mahantha Thakur",         "politician", "https://en.wikipedia.org/wiki/Mahantha_Thakur"),
    ("Gyanendra of Nepal",      "politician", "https://en.wikipedia.org/wiki/Gyanendra_of_Nepal"),
]

PARTIES = [
    ("Nepali Congress",
     "party", "https://en.wikipedia.org/wiki/Nepali_Congress"),
    ("Communist Party of Nepal (Unified Marxist-Leninist)",
     "party", "https://en.wikipedia.org/wiki/CPN%E2%80%93UML"),
    ("Communist Party of Nepal (Maoist Centre)",
     "party", "https://en.wikipedia.org/wiki/Communist_Party_of_Nepal_(Maoist_Centre)"),
    ("Rastriya Swatantra Party",
     "party", "https://en.wikipedia.org/wiki/Rastriya_Swatantra_Party"),
    ("CPN (Unified Socialist)",
     "party", "https://en.wikipedia.org/wiki/CPN_(Unified_Socialist)"),
    ("Rastriya Prajatantra Party",
     "party", "https://en.wikipedia.org/wiki/Rastriya_Prajatantra_Party"),
    ("Janajati Samajbadi Party Nepal",
     "party", "https://en.wikipedia.org/wiki/Janajati_Samajbadi_Party_Nepal"),
    ("Loktantrik Samajwadi Party",
     "party", "https://en.wikipedia.org/wiki/Loktantrik_Samajwadi_Party"),
]

HISTORY_TOPICS = [
    ("People's War Nepal",
     "history", "https://en.wikipedia.org/wiki/People%27s_War_(Nepal)"),
    ("Comprehensive Peace Agreement Nepal",
     "history", "https://en.wikipedia.org/wiki/Comprehensive_Peace_Agreement_(Nepal)"),
    ("2006 Nepal democracy movement",
     "history", "https://en.wikipedia.org/wiki/2006_Nepalese_democracy_movement"),
    ("2015 Nepal earthquake",
     "history", "https://en.wikipedia.org/wiki/2015_Nepal_earthquake"),
    ("Federalism in Nepal",
     "history", "https://en.wikipedia.org/wiki/Federal_Democratic_Republic_of_Nepal"),
    ("History of Nepal",
     "history", "https://en.wikipedia.org/wiki/History_of_Nepal"),
    ("Madhesi people",
     "history", "https://en.wikipedia.org/wiki/Madhesi_people"),
    ("Economy of Nepal",
     "history", "https://en.wikipedia.org/wiki/Economy_of_Nepal"),
    ("2015 Nepal blockade",
     "history", "https://en.wikipedia.org/wiki/2015%E2%80%9316_Nepal_blockade"),
    ("National Reconstruction Authority Nepal",
     "history", "https://en.wikipedia.org/wiki/National_Reconstruction_Authority_(Nepal)"),
]

FOREIGN_AFFAIRS_TOPICS = [
    ("India Nepal relations",
     "foreign_affairs", "https://en.wikipedia.org/wiki/India%E2%80%93Nepal_relations"),
    ("China Nepal relations",
     "foreign_affairs", "https://en.wikipedia.org/wiki/China%E2%80%93Nepal_relations"),
    ("Belt and Road Initiative Nepal",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Belt_and_Road_Initiative"),
    ("Kalapani territory dispute",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Kalapani_territory"),
    ("Susta territorial dispute",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Susta"),
    ("Nepal United States relations",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Nepal%E2%80%93United_States_relations"),
    ("Nepal United Nations",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Nepal_and_the_United_Nations"),
    ("Millennium Challenge Corporation Nepal",
     "foreign_affairs", "https://en.wikipedia.org/wiki/Millennium_Challenge_Corporation"),
]


# ── Infobox Parser ────────────────────────────────────────────────────────────

def parse_infobox(wikitext: str) -> dict:
    """
    Extract structured key-value pairs from Wikipedia infobox wikitext.

    Targets fields most useful for politician/party profiles:
    office, party, birth_date, constituency, term_start, term_end.

    Returns a clean dict — no raw wikitext, no markup.
    """
    infobox = {}

    # Find the infobox block
    start = wikitext.find("{{Infobox")
    if start == -1:
        start = wikitext.find("{{infobox")
    if start == -1:
        return infobox

    # Extract until matching closing braces
    depth = 0
    end = start
    for i, ch in enumerate(wikitext[start:], start):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    infobox_text = wikitext[start:end]

    # Field patterns we care about
    field_map = {
        "office":           r"\|\s*office\s*=\s*(.+)",
        "party":            r"\|\s*party\s*=\s*(.+)",
        "birth_date":       r"\|\s*birth_date\s*=\s*(.+)",
        "birth_place":      r"\|\s*birth_place\s*=\s*(.+)",
        "constituency":     r"\|\s*constituency\s*=\s*(.+)",
        "term_start":       r"\|\s*term_start\s*=\s*(.+)",
        "term_end":         r"\|\s*term_end\s*=\s*(.+)",
        "predecessor":      r"\|\s*predecessor\s*=\s*(.+)",
        "successor":        r"\|\s*successor\s*=\s*(.+)",
        "nationality":      r"\|\s*nationality\s*=\s*(.+)",
        "alma_mater":       r"\|\s*alma_mater\s*=\s*(.+)",
        "founded":          r"\|\s*founded\s*=\s*(.+)",
        "ideology":         r"\|\s*ideology\s*=\s*(.+)",
        "headquarters":     r"\|\s*headquarters\s*=\s*(.+)",
        "leader":           r"\|\s*leader\s*=\s*(.+)",
        "chairperson":      r"\|\s*chairperson\s*=\s*(.+)",
    }

    for key, pattern in field_map.items():
        match = re.search(pattern, infobox_text, re.IGNORECASE)
        if match:
            raw_val = match.group(1).strip()
            # Strip wiki markup: [[links]], {{templates}}, <tags>
            clean_val = re.sub(r'\[\[([^\|\]]+\|)?([^\]]+)\]\]', r'\2', raw_val)
            clean_val = re.sub(r'\{\{[^}]+\}\}', '', clean_val)
            clean_val = re.sub(r'<[^>]+>', '', clean_val)
            clean_val = clean_val.strip(" |,")
            if clean_val:
                infobox[key] = clean_val

    return infobox


# ── WikiScraper ───────────────────────────────────────────────────────────────

class WikiScraper:
    def __init__(self):
        self.base_url = "https://en.wikipedia.org/w/api.php"
        self.headers  = {"User-Agent": WIKI_USER_AGENT}

    # ── Fetch ─────────────────────────────────────────────────────────────────

    def fetch_page(self, title: str) -> Tuple[Optional[str], Optional[dict]]:
        """
        Fetch plain-text extract + raw wikitext from MediaWiki API.
        Returns (clean_text, infobox_dict) or (None, None) on failure.
        """
        params = {
            "action":      "query",
            "format":      "json",
            "titles":      title,
            "prop":        "extracts|revisions",
            "explaintext": True,       # plain text, no HTML
            "exsectionformat": "plain",
            "rvprop":      "content",
            "rvslots":     "main",
        }

        for attempt in range(3):
            try:
                time.sleep(WIKI_REQUEST_DELAY)
                response = requests.get(
                    self.base_url, params=params, headers=self.headers, timeout=15
                )

                if response.status_code == 429:
                    raise requests.exceptions.RequestException("Rate Limited (429)")

                response.raise_for_status()
                data  = response.json()
                pages = data["query"]["pages"]
                page_id = list(pages.keys())[0]

                if page_id == "-1":
                    logger.warning(f"[WIKI] Page not found: {title}")
                    return None, None

                raw_text = pages[page_id].get("extract", "")
                if not raw_text:
                    logger.warning(f"[WIKI] Empty extract for: {title}")
                    return None, None

                clean_text = clean_wiki_text(raw_text)

                # Extract infobox from raw wikitext
                wikitext = (
                    pages[page_id]
                    .get("revisions", [{}])[0]
                    .get("slots", {})
                    .get("main", {})
                    .get("*", "")
                )
                infobox = parse_infobox(wikitext)

                return clean_text, infobox

            except Exception as e:
                if attempt < 2:
                    wait = WIKI_RETRY_DELAYS[attempt]
                    logger.warning(
                        f"[WIKI] Attempt {attempt+1} failed for '{title}' — "
                        f"retrying in {wait}s. Error: {e}"
                    )
                    time.sleep(wait)
                else:
                    logger.error(
                        f"[WIKI] Failed '{title}' after 3 attempts. Skipping. Error: {e}"
                    )
                    return None, None

    # ── Process ───────────────────────────────────────────────────────────────

    def process_entity(self, name: str, entity_type: str, url: str):
        """
        Full pipeline for one entity:
        1. Fetch Wikipedia page
        2. Save infobox to politicians table (if politician)
        3. Chunk article text
        4. Insert/deduplicate each chunk into context_chunks
        """
        logger.info(f"[{entity_type.upper()}] Processing: {name}")
        text, infobox = self.fetch_page(name)

        if not text:
            logger.error(f"[SKIP] No content retrieved for: {name}")
            return

        # ── Save structured infobox for politicians ───────────────────────────
        if entity_type == "politician" and infobox:
            politician_record = {
                "name":                   name,
                "role":                   infobox.get("office", None),
                "party":                  infobox.get("party", None),
                "electoral_constituency": infobox.get("constituency", None),
                "birth_date":             _parse_date(infobox.get("birth_date")),
                "infobox_raw":            infobox,
                "last_verified":          date.today().isoformat(),
                "needs_review":           False,
            }
            insert_or_update_politician(politician_record)

        # ── Chunk and store article text ──────────────────────────────────────
        chunks = semantic_chunk_text(text)
        today  = date.today().isoformat()

        for idx, chunk in enumerate(chunks):
            chunk_hash = generate_hash(chunk)
            payload = {
                "content":          chunk,
                "content_hash":     chunk_hash,
                "entity_type":      entity_type,
                "entity_name":      name,
                "source":           "wikipedia",
                "source_url":       url,
                "date_published":   None,
                "last_verified":    today,
                "needs_review":     False,
                "verified":         False,     # Tier 2 — contextual
                "chunk_index":      idx,
                "chunk_size_chars": len(chunk),
                "embedding":        None,      # Populated in Phase 2
                "amendment_status": None,
                "valid_from_date":  None,
                "superseded_by":    None,
            }
            insert_or_update_chunk(payload)

        logger.info(
            f"[DONE] {entity_type.upper()} | {name} | "
            f"{len(chunks)} chunks stored"
        )

    # ── Batch Runners ─────────────────────────────────────────────────────────

    def seed_politicians(self):
        logger.info("=" * 60)
        logger.info("SEEDING POLITICIANS")
        logger.info("=" * 60)
        for name, entity_type, url in POLITICIANS:
            self.process_entity(name, entity_type, url)

    def seed_parties(self):
        logger.info("=" * 60)
        logger.info("SEEDING POLITICAL PARTIES")
        logger.info("=" * 60)
        for name, entity_type, url in PARTIES:
            self.process_entity(name, entity_type, url)

    def seed_history(self):
        logger.info("=" * 60)
        logger.info("SEEDING HISTORICAL CONTEXT")
        logger.info("=" * 60)
        for name, entity_type, url in HISTORY_TOPICS:
            self.process_entity(name, entity_type, url)

    def seed_foreign_affairs(self):
        logger.info("=" * 60)
        logger.info("SEEDING FOREIGN AFFAIRS")
        logger.info("=" * 60)
        for name, entity_type, url in FOREIGN_AFFAIRS_TOPICS:
            self.process_entity(name, entity_type, url)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_date(raw: Optional[str]) -> Optional[str]:
    """Try to extract a YYYY-MM-DD date from messy infobox date strings."""
    if not raw:
        return None
    match = re.search(r'(\d{4})-(\d{2})-(\d{2})', raw)
    if match:
        return match.group(0)
    match = re.search(r'(\d{4})', raw)
    if match:
        return f"{match.group(1)}-01-01"
    return None
