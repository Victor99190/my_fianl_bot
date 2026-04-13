# Scraper Configuration Guide

## Issue: Duplicate Articles with New Names

The scraper might be outputting old articles with new filenames. Here's how to fix it:

### Root Causes

1. **Same content, different filename**: Scraper re-scrapes but names files by time
2. **Cache not clearing**: Old files not being removed
3. **Title/Content variations**: Same article slightly rewor ded appears as new

###Solution: Update scraper configuration

Edit `scraper/runner.py` in the scraper repo to ensure:

```python
# 1. Only fetch fresh articles (recently published)
since_hours=2  # Only articles from last 2 hours

# 2. Check against existing URls
find_existing_urls(folder)  # Loads all previously scraped URLs

# 3. Skip if already scraped
if url in self.seen_urls:
    continue

# 4. Clean up old files regularly
cleanup_old_files(folder, retention_days=2)
```

### GitHub Actions for Scraper

Add to scraper's workflows (if not already there):

```yaml
name: Scrape News

on:
  schedule:
    - cron: '*/15 * * * *'  # Every 15 minutes
  
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      - name: Install dependencies
        run: pip install -r requirements.txt
      - name: Run scraper
        run: python scrape.py --since-hours 2 --max-links 50
      - name: Commit results
        run: |
          git config --global user.name "Scraper Bot"
          git config --global user.email "scraper@github.com"
          git add data/
          git commit -m "Scheduled scrape" || true
          git push
```

### Parameters to Tune

```python
--since-hours 2       # Only scrape articles published in last 2 hours
--max-links 50        # Max 50 links per site (default: 50)
--delay 1.5           # Wait 1.5 seconds between requests
--retention 2         # Keep only last 2 days of data
--include-unknown-date  # Include articles without date (false by default)
```

### Expected Output Structure

```
data/
├── onlinekhabar/
│   └── 2026-04-13/
│       ├── 2026-04-13_onlinekhabar_article-title-slug.json
│       └── ...more articles...
├── setopati/
│   └── 2026-04-13/
│       └── ...articles...
├── bbcnepali/
└── ...other sites...
```

### Each Article Must Have

```json
{
  "source": "onlinekhabar",
  "url": "https://www.onlinekhabar.com/article...",
  "title": "Article Title",
  "published_at": "2026-04-13T15:30:00",
  "scraped_at": "2026-04-13T15:35:00",
  "summary": "Short summary",
  "content": "Full article content...",
  "authors": ["Author Name"],
  "main_image": "https://...",
  "image_urls": ["https://..."],
  "tags": ["Politics", "Nepal"],
  "meta": { "og:description": "..." }
}
```

### Debugging

Check what files the scraper generated:

```bash
find data/ -name "*.json" | head -20
wc -l data/*/*.json  # Count articles by source
```

Check if duplicate URLs exist:

```bash
grep -h '"url"' data/*/*/*json | sort | uniq -d | head -10
```

### Bot Integration

The bot reads from scraper's `data/` directory every 25 minutes:
- Looks in each site folder for latest date
- Reads all `.json` files
- Checks against `posted_history.json`
- Posts up to 2 new articles per run

**The scraper → bot pipeline:**
```
[Scraper finds fresh article] 
    → [Saves to data/source/YYYY-MM-DD/file.json]
    → [Bot reads latest date folder]
    → [Checks if already posted]
    → [Summarizes with Gemini]
    → [Posts to Facebook]
    → [Records in posted_history.json]
```

### Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| Same article with different filename | Check `find_existing_urls()` in scraper |
| Old dates in articles | Verify date parsing in `parse_date()` |
| Missing content | Check CSS selectors in `sites.py` match website |
| Overwriting previous articles | Ensure `--retention 2` deletes old files |
| Too many duplicates | Lower `--since-hours` to 1 hour, increase frequency |

---

**Scraper Repo**: https://github.com/Victor99190/final-scrapeer
**Bot Repo**: https://github.com/Victor99190/my_fianl_bot
