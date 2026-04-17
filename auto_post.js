const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const path = require("path");
const { execSync } = require("child_process");
const Database = require("better-sqlite3");

// ============================================================================
// DEDUPLICATION MANAGER - 4-Layer Approach
// ============================================================================

class DeduplicationManager {
  constructor(dbPath = "./dedup.db") {
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  initializeSchema() {
    // Create articles table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_url TEXT NOT NULL UNIQUE,
        title_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        original_url TEXT NOT NULL,
        title TEXT NOT NULL,
        posted_at INTEGER,
        UNIQUE(title_hash, content_hash)
      );
      
      CREATE INDEX IF NOT EXISTS idx_normalized_url ON articles(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_posted_at ON articles(posted_at);
    `);
  }

  /**
   * Layer 1: Normalize URL to catch variations
   * Removes query params, fragments, trailing slashes, protocol differences
   */
  normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.search = ""; // Remove query parameters
      u.hash = ""; // Remove fragments
      return u.toString().toLowerCase();
    } catch (e) {
      console.warn(`⚠️ URL parsing failed for: ${url}`);
      return url.toLowerCase();
    }
  }

  /**
   * Layer 2: Generate fingerprint from title + first 500 chars of content
   * Catches duplicates even if content is slightly reformatted
   */
  generateFingerprint(title, content) {
    const titleHash = crypto
      .createHash("sha256")
      .update(title.toLowerCase().trim())
      .digest("hex");

    const contentSample = (content || "").substring(0, 500).toLowerCase();
    const contentHash = crypto
      .createHash("sha256")
      .update(contentSample)
      .digest("hex");

    return { titleHash, contentHash };
  }

  /**
   * Layer 3: Check if article was recently posted (cooldown)
   * Don't repost same URL within 7 days
   */
  isInCooldown(normalizedUrl, cooldownDays = 7) {
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      `SELECT posted_at FROM articles WHERE normalized_url = ? AND posted_at IS NOT NULL`
    );
    const result = stmt.get(normalizedUrl);

    if (!result) return false; // Never posted

    const timeSincePosted = Date.now() - result.posted_at;
    return timeSincePosted < cooldownMs;
  }

  /**
   * Layer 4: Comprehensive deduplication check
   * Returns: { isDuplicate: boolean, reason: string }
   */
  checkDuplicate(article) {
    const { title, url, content } = article;
    const normalizedUrl = this.normalizeUrl(url);
    const { titleHash, contentHash } = this.generateFingerprint(title, content);

    // Check 1: Exact URL match (with normalization)
    const stmt1 = this.db.prepare(
      `SELECT id, posted_at FROM articles WHERE normalized_url = ?`
    );
    const existingByUrl = stmt1.get(normalizedUrl);

    if (existingByUrl) {
      const daysAgo = Math.floor(
        (Date.now() - (existingByUrl.posted_at || 0)) / (24 * 60 * 60 * 1000)
      );
      return {
        isDuplicate: true,
        reason: `URL already posted ${daysAgo} days ago`,
        articleId: existingByUrl.id,
      };
    }

    // Check 2: Content fingerprint match (catches reformatted content)
    const stmt2 = this.db.prepare(
      `SELECT id FROM articles WHERE title_hash = ? AND content_hash = ?`
    );
    const existingByContent = stmt2.get(titleHash, contentHash);

    if (existingByContent) {
      return {
        isDuplicate: true,
        reason: `Content fingerprint matches article #${existingByContent.id}`,
        articleId: existingByContent.id,
      };
    }

    // Check 3: Cooldown (don't repost within 7 days even if content changes)
    if (this.isInCooldown(normalizedUrl)) {
      return {
        isDuplicate: true,
        reason: `URL in 7-day cooldown`,
      };
    }

    return { isDuplicate: false, reason: "New article" };
  }

  /**
   * Record an article as posted
   */
  recordPosted(article) {
    const { title, url, content } = article;
    const normalizedUrl = this.normalizeUrl(url);
    const { titleHash, contentHash } = this.generateFingerprint(title, content);

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO articles 
       (normalized_url, title_hash, content_hash, original_url, title, posted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    try {
      stmt.run(normalizedUrl, titleHash, contentHash, url, title, Date.now());
      return true;
    } catch (e) {
      console.warn(`⚠️ Failed to record article: ${e.message}`);
      return false;
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    const total = this.db.prepare(`SELECT COUNT(*) as count FROM articles`).get();
    const postedToday = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM articles 
         WHERE posted_at IS NOT NULL 
         AND posted_at > ?`
      )
      .get(Date.now() - 24 * 60 * 60 * 1000);

    return {
      totalTracked: total.count,
      postedToday: postedToday.count,
    };
  }

  close() {
    this.db.close();
  }
}

// ============================================================================
// MAIN BOT
// ============================================================================

async function runBot() {
  console.log("\n" + "=".repeat(70));
  console.log("🚀 NEPAL NEWS BOT v2 - Starting (SQLite Dedup)");
  console.log("=".repeat(70) + "\n");

  // Validate environment variables
  const required = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Initialize deduplication manager
  const dedup = new DeduplicationManager("./dedup.db");
  const stats = dedup.getStats();
  console.log(`📊 Database: ${stats.totalTracked} articles tracked, ${stats.postedToday} posted today\n`);

  try {
    // Read scraper data
    const dataDir = "./scraper_repo/data";
    let articles = [];

    console.log("📂 Reading scraped articles...\n");

    try {
      const sites = await fs.readdir(dataDir);

      for (const site of sites) {
        const sitePath = `${dataDir}/${site}`;
        try {
          const stat = await fs.stat(sitePath);
          if (!stat.isDirectory()) continue;

          const dates = await fs.readdir(sitePath);
          const latestDate = dates
            .filter((d) => !d.startsWith("."))
            .sort()
            .reverse()[0];
          if (!latestDate) continue;

          const files = await fs.readdir(`${sitePath}/${latestDate}`);
          const jsonFiles = files.filter((f) => f.endsWith(".json")).length;
          console.log(`   📄 ${site}/${latestDate}: ${jsonFiles} files`);

          for (const file of files) {
            if (!file.endsWith(".json")) continue;

            try {
              const data = await fs.readFile(
                `${sitePath}/${latestDate}/${file}`,
                "utf8"
              );
              const article = JSON.parse(data);

              // Validate required fields
              if (!article.title || !article.url || !article.content) {
                continue;
              }

              articles.push({
                title: article.title,
                content: article.content,
                url: article.url,
                source: article.source || site,
                published_at: article.published_at || new Date().toISOString(),
              });
            } catch (e) {
              // Silently skip malformed files
            }
          }
        } catch (e) {
          // Silently skip inaccessible sites
        }
      }
    } catch (e) {
      console.error(`❌ Cannot read scraper data: ${e.message}`);
      console.error("Make sure scraper_repo is cloned and has data/");
      dedup.close();
      process.exit(1);
    }

    console.log(`\n✨ Found ${articles.length} articles from scraper\n`);

    if (articles.length === 0) {
      console.log("⚠️ No articles to process");
      dedup.close();
      return;
    }

    // Apply deduplication filter
    const newArticles = [];
    for (const article of articles) {
      const check = dedup.checkDuplicate(article);
      if (check.isDuplicate) {
        console.log(
          `   ⏭️ Skip: ${article.title.substring(0, 50)}... (${check.reason})`
        );
      } else {
        newArticles.push(article);
      }
    }

    console.log(`\n🆕 ${newArticles.length} new articles after dedup\n`);

    if (newArticles.length === 0) {
      console.log("✅ No new content to post");
      dedup.close();
      return;
    }

    // Sort by content length (quality proxy)
    newArticles.sort(
      (a, b) => (b.content?.length || 0) - (a.content?.length || 0)
    );

    // Post up to 2 articles per run
    const toPost = newArticles.slice(0, 2);
    let posted = 0;

    for (let i = 0; i < toPost.length; i++) {
      const article = toPost[i];
      console.log("=".repeat(70));
      console.log(`📰 Article ${i + 1}/${toPost.length}: ${article.title.substring(0, 55)}`);
      console.log("=".repeat(70));

      try {
        // Summarize with retries
        let summary;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const prompt = `In 2-3 sentences, summarize this Nepali news for Facebook. Be engaging and informative:

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Reply with ONLY the summary, nothing else.`;

            const result = await model.generateContent(prompt);
            summary = result.response.text().trim();

            if (summary && summary.length > 20) {
              console.log("✅ Summarized");
              break;
            }
          } catch (e) {
            if (attempt === 3) throw e;
            console.log(`   ⚠️ Attempt ${attempt}/3 failed, retrying...`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        if (!summary || summary.length < 20) {
          console.error("❌ Failed to generate summary");
          continue;
        }

        const post = `🚨 **${article.title}**

${summary}

📰 Source: ${article.source}
🔗 Read more: ${article.url}

#NepalNews #Breaking`;

        // Post to Facebook
        console.log("📤 Posting to Facebook...");
        const res = await axios.post(
          `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`,
          {
            message: post,
            access_token: process.env.FB_PAGE_TOKEN,
          }
        );

        if (res.data.id) {
          console.log(`✅ Posted! ${res.data.id}\n`);
          dedup.recordPosted(article);
          posted++;

          // Wait before next post
          if (i < toPost.length - 1) {
            console.log("⏳ Waiting 10 seconds before next post...");
            await new Promise((r) => setTimeout(r, 10000));
          }
        } else {
          console.error("❌ No post ID returned\n");
        }
      } catch (e) {
        console.error(`❌ Error: ${e.message}\n`);
      }
    }

    console.log("=".repeat(70));
    console.log(`✅ BOT COMPLETE - Posted ${posted} articles, tracked in SQLite`);
    console.log("=".repeat(70) + "\n");

    dedup.close();
  } catch (e) {
    console.error(`\n❌ FATAL ERROR: ${e.message}`);
    dedup.close();
    process.exit(1);
  }
}

runBot().catch(console.error);
