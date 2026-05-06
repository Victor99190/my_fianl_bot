const { GoogleGenerativeAI } = require("@google/generative-ai");  
const axios = require("axios");  
const Database = require("better-sqlite3");  
const fs = require("fs");  
const path = require("path");  
const crypto = require("crypto");
const PostRateLimiter = require("./rate-limiter");

// Setup logging to both console and file
const logFile = "./bot.log";
const originalLog = console.log;
const originalError = console.error;

function log(...args) {
  const message = args.join(" ");
  originalLog(message);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

function logError(...args) {
  const message = args.join(" ");
  originalError(message);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR: ${message}\n`);
}

console.log = log;
console.error = logError;

async function runBot() {  
  log("\n🚀 NEPAL NEWS BOT - Rate Limited + Importance Filter\n");

  // Check env vars  
  const required = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];  
  const missing = required.filter((v) => !process.env[v]);  
  if (missing.length > 0) {  
    logError(`❌ Missing: ${missing.join(", ")}`);  
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

  // Init rate limiter (uses rate_limit.db)
  const rateLimiter = new PostRateLimiter("./rate_limit.db");
  const stats = rateLimiter.getStats();
  log(`📊 Rate limit stats: ${stats.postsLastHour}/2 this hour, ${stats.postsLastDay}/24 today`);
  log(`⏱️ Last post: ${typeof stats.lastPost === 'string' ? stats.lastPost : stats.lastPost.timeAgo}\n`);

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

    let stmt = db.prepare("SELECT id FROM articles WHERE normalized_url = ?");  
    if (stmt.get(normUrl)) {  
      return true;  
    }

    stmt = db.prepare("SELECT id FROM articles WHERE title_hash = ?");  
    if (stmt.get(hash)) {  
      return true;  
    }

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;  
    stmt = db.prepare(  
      "SELECT posted_at FROM articles WHERE normalized_url = ? AND posted_at > ?"  
    );  
    if (stmt.get(normUrl, sevenDaysAgo)) {  
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
    logError(`❌ Cannot read scraper data: ${e.message}`);  
    db.close();  
    rateLimiter.close();  
    process.exit(1);  
  }

  log(`📰 Found ${articles.length} articles\n`);

  // Filter duplicates  
  const newArticles = articles.filter(  
    (a) => !isDuplicate(a.title, a.url, a.content)  
  );

  log(`✨ ${newArticles.length} new articles\n`);

  if (newArticles.length === 0) {  
    log("✅ No new articles found\n");  
    db.close();  
    rateLimiter.close();  
    return;  
  }

  // Score importance  
  log("🔍 Scoring importance...\n");
  const scoredArticles = [];

  for (const article of newArticles) {
    try {
      const scoreResult = await model.generateContent(
        `Rate the importance of this Nepali news article on a scale of 1-10. Consider: national impact, policy/political significance, public health/safety, economic importance, disaster/emergency, or widespread affect on Nepali citizens.

Title: ${article.title}
Content: ${article.content.substring(0, 300)}

Reply with ONLY a number (1-10) and a one-word category (CRITICAL/HIGH/MEDIUM/LOW).
Example: "9 CRITICAL" or "4 LOW"`
      );
      
      const scoreText = scoreResult.response.text().trim();
      const match = scoreText.match(/(\d+)\s+(\w+)/);
      const score = match ? parseInt(match[1]) : 3;
      const category = match ? match[2] : "LOW";

      scoredArticles.push({
        ...article,
        score,
        category,
      });

      log(`   ${category.padEnd(8)} (${score}/10) - ${article.title.substring(0, 45)}`);
    } catch (e) {
      log(`   ⚠️ Score error: ${article.title.substring(0, 40)}`);
      scoredArticles.push({ ...article, score: 3, category: "LOW" });
    }
  }

  // Filter: only CRITICAL/HIGH (score >= 7)  
  const importantArticles = scoredArticles.filter((a) => a.score >= 7);
  log(`\n🎯 Important articles: ${importantArticles.length}/${scoredArticles.length}\n`);

  // ========== RATE LIMITING DECISION ==========
  const limitCheck = rateLimiter.canPost(importantArticles.length);
  log(`⏱️ Rate Limiter: ${limitCheck.reason}\n`);

  if (!limitCheck.shouldPost) {
    if (importantArticles.length > 0) {
      log("⚠️ Important content found BUT rate limit active. Skipping post.");
      log(`   Next eligible: ${new Date(limitCheck.nextEligibleAt).toLocaleString()}\n`);
    } else {
      log("✅ No important content + rate limit active. Skipping.\n");
    }
    db.close();  
    rateLimiter.close();  
    return;  
  }

  if (importantArticles.length === 0) {
    log("⚠️ No important articles found. Skipping post.\n");
    db.close();  
    rateLimiter.close();  
    return;  
  }

  // Only post if we can AND have important content
  const maxPosts = Math.min(limitCheck.maxPostsAllowed, importantArticles.length);
  const toPost = importantArticles.slice(0, maxPosts);
  log(`📤 Proceeding with ${toPost.length} post(s)\n`);

  let posted = 0;

  for (const article of toPost) {  
    log(`📝 Processing: ${article.title.substring(0, 50)}...`);

    try {  
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

Reply with ONLY the two-part summary as specified above first part in in Romanized Nepali.`  
);  
          summary = result.response.text().trim();  
          if (summary && summary.length > 20) break;  
        } catch (e) {  
          if (attempt === 3) throw e;  
          await new Promise((r) => setTimeout(r, 2000));  
        }  
      }

      if (!summary || summary.length < 20) {  
        log("   ❌ Summary failed");  
        continue;  
      }

      const post = `${summary}\n\n📰 Source: ${article.source}\n\n#NepalNews #Breaking \nNote: AI generated news\nAI can make mistakes`;

      const res = await axios.post(  
        `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`,  
        { message: post, access_token: process.env.FB_PAGE_TOKEN },  
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }  
      );

      if (res.data.id) {  
        log(`   ✅ Posted! ${res.data.id}`);  
        recordPosted(article.title, article.url, article.content);  
        rateLimiter.recordPost(article.title, article.score);  
        posted++;

        if (posted < toPost.length) {  
          await new Promise((r) => setTimeout(r, 10000));  
        }  
      }  
    } catch (e) {  
      logError(`   ❌ Error: ${e.message}`);  
    }  
  }

  log(`\n✅ Complete - Posted ${posted} articles\n`);  
  db.close();  
  rateLimiter.close();  
}

runBot().catch(logError);
