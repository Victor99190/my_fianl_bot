const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

async function runBot() {
  console.log("\n🚀 NEPAL NEWS BOT - SQLite Dedup\n");

  // Check env vars
  const required = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Init DB
  const db = new Database("./dedup.db");
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY,
      normalized_url TEXT UNIQUE,
      title_hash TEXT,
      content_hash TEXT,
      posted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_url ON articles(normalized_url);
  `);

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

  // Helper functions
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      return u.toString().toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  function getHash(title, content) {
    const sample = (content || "").substring(0, 500).toLowerCase();
    return crypto.createHash("sha256").update(title + sample).digest("hex");
  }

  function isDuplicate(title, url, content) {
    const normUrl = normalizeUrl(url);
    const hash = getHash(title, content);

    // Check URL
    let stmt = db.prepare("SELECT id FROM articles WHERE normalized_url = ?");
    if (stmt.get(normUrl)) {
      console.log(`   ⏭️ URL exists: ${title.substring(0, 40)}`);
      return true;
    }

    // Check hash
    stmt = db.prepare("SELECT id FROM articles WHERE title_hash = ?");
    if (stmt.get(hash)) {
      console.log(`   ⏭️ Content hash matches: ${title.substring(0, 40)}`);
      return true;
    }

    // Check cooldown (7 days)
    stmt = db.prepare(
      "SELECT posted_at FROM articles WHERE normalized_url = ? AND posted_at > ?"
    );
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (stmt.get(normUrl, sevenDaysAgo)) {
      console.log(`   ⏳ Still in cooldown: ${title.substring(0, 40)}`);
      return true;
    }

    return false;
  }

  function recordPosted(title, url, content) {
    const normUrl = normalizeUrl(url);
    const hash = getHash(title, content);
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO articles (normalized_url, title_hash, content_hash, posted_at) VALUES (?, ?, ?, ?)"
    );
    stmt.run(normUrl, hash, hash, Date.now());
  }

  // Read articles
  let articles = [];
  const dataDir = "./scraper_repo/data";

  try {
    const sites = fs.readdirSync(dataDir);
    for (const site of sites) {
      const sitePath = `${dataDir}/${site}`;
      if (!fs.statSync(sitePath).isDirectory()) continue;

      const dates = fs.readdirSync(sitePath).filter((d) => !d.startsWith(".")).sort().reverse();
      const latestDate = dates[0];
      if (!latestDate) continue;

      const files = fs.readdirSync(`${sitePath}/${latestDate}`).filter((f) => f.endsWith(".json"));

      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(`${sitePath}/${latestDate}/${file}`, "utf8")
          );
          if (data.title && data.url && data.content) {
            articles.push({
              title: data.title,
              url: data.url,
              content: data.content,
              source: data.source || site,
            });
          }
        } catch (e) {
          // Skip bad files
        }
      }
    }
  } catch (e) {
    console.error(`❌ Cannot read scraper data: ${e.message}`);
    db.close();
    process.exit(1);
  }

  console.log(`📰 Found ${articles.length} articles\n`);

  // Filter duplicates
  const newArticles = articles.filter(
    (a) => !isDuplicate(a.title, a.url, a.content)
  );

  console.log(`✨ ${newArticles.length} new articles\n`);

  if (newArticles.length === 0) {
    console.log("✅ All articles already tracked");
    db.close();
    return;
  }

  // Sort by content length
  newArticles.sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));

  // Post up to 2
  const toPost = newArticles.slice(0, 1);
  let posted = 0;

  for (const article of toPost) {
    console.log(`📤 Processing: ${article.title.substring(0, 50)}...`);

    try {
      // Summarize
      let summary;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await model.generateContent(
  `Summarize this Nepali news article in exactly two parts (maximum 350 words total):

**Part 1 (Romanized Nepali):**
- Write 3-5 sentences in Romanized Nepali (Nepali spoken language using English alphabet, mixing common English words naturally)
- Cover the core facts: what happened, where, key numbers/outcomes
- Start directly with the content—no labels like "Summary:" or extra spacing
- Be factual and precise
- Write naturally as spoken by everyday Nepali people in casual conversation
- For technical/specialized English terms, use simple Nepali words or commonly understood alternatives
- Avoid awkward direct translations of jargon—explain concepts in plain language
- Think: "How would I explain this news to a friend over tea?"
- Keep in mind this news is targeted to nepali youth.
- Dont use disrespect word always write news respectfully and write first part in romanize nepali

**Part 2 (Devanagari Nepali):**
-Dont try to just copy orginal post write creatively as orginal post 
- Leave one blank line after Part 1
- Write 5-10 sentences in Nepali (Devanagari script)
- use simple plain nepali 
- Use formal, respectful language appropriate for traditional Nepali journalism
- Use honorific forms: "गर्नुभयो/गर्नुभएको" instead of "गरे/गरेका", "भन्नुभयो" instead of "भने"
- Use "जानुभयो/आउनुभयो" (respectful) instead of "गए/आए" (informal timi form) 
- Maintain professional tone similar to established Nepali newspapers
- Expand on context: why it matters, background, actions being taken, implications
- Provide NEW information, not just translation of Part 1
- Include relevant details that help readers understand the broader situation

**Guidelines:**
-Write in bullet points
-Dont sound bias even  if biasness found in scrapped news. 
- Avoid fluff—get straight to essential facts
- Use clear, direct language
- Don't write meta-labels (no "Summary:", "विवरण:", etc.)
- Don't add extra spacing or formatting markers
- Don't include the article title in your response

**Content to summarize:**
${article.content.substring(0, 500)}

Reply with ONLY the two-part summary as specified above first part in in Romanized Nepali (Nepali spoken language using English alphabet, mixing common English words naturally) .`
);
          summary = result.response.text().trim();
          if (summary && summary.length > 20) break;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      if (!summary || summary.length < 20) {
        console.log("   ❌ Summary failed");
        continue;
      }

      // Post to Facebook
      // Force UTF-8 header in Axios request
      const post = `${summary}\n\n📰 Source: ${article.source}\n\n#NepalNews #Breaking \nNote:This is AI generated news\nAI can make mistake `;

      const res = await axios.post(
        `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`,
        { message: post, access_token: process.env.FB_PAGE_TOKEN },
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );

      if (res.data.id) {
        console.log(`   ✅ Posted! ${res.data.id}`);
        recordPosted(article.title, article.url, article.content);
        posted++;

        if (posted < toPost.length) {
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
    } catch (e) {
      console.error(`   ❌ Error: ${e.message}`);
    }
  }

  console.log(`\n✅ Complete - Posted ${posted} articles\n`);
  db.close();
}

runBot().catch(console.error);
