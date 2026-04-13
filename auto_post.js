const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const path = require("path");
const { execSync } = require('child_process');

async function runBot() {
  console.log("\n" + "=".repeat(70));
  console.log("🚀 NEPAL NEWS BOT - Starting");
  console.log("=".repeat(70) + "\n");

  // Validate env vars
  const required = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Utility: Generate content hash
  function hashContent(title, url) {
    return crypto.createHash('md5').update(`${title}||${url}`).digest('hex');
  }

  // Load history
  async function loadHistory() {
    try {
      const filePath = './posted_history.json';
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return { hashes: [], count: 0 };
    }
  }

  // Save history
  async function saveHistory(hist) {
    await fs.writeFile('./posted_history.json', JSON.stringify(hist, null, 2));
  }

  try {
    const history = await loadHistory();
    console.log(`📊 Loaded history: ${history.hashes.length} articles tracked\n`);

    // Read scraper data
    const dataDir = './scraper_repo/data';
    let articles = [];

    try {
      const sites = await fs.readdir(dataDir);
      
      for (const site of sites) {
        const sitePath = `${dataDir}/${site}`;
        try {
          const stat = await fs.stat(sitePath);
          if (!stat.isDirectory()) continue;

          const dates = await fs.readdir(sitePath);
          const latestDate = dates.filter(d => !d.startsWith('.')).sort().reverse()[0];
          if (!latestDate) continue;

          const files = await fs.readdir(`${sitePath}/${latestDate}`);
          console.log(`📂 ${site}/${latestDate}: ${files.filter(f => f.endsWith('.json')).length} files`);

          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const data = await fs.readFile(`${sitePath}/${latestDate}/${file}`, 'utf8');
              const article = JSON.parse(data);

              // Validate
              if (!article.title || !article.url || !article.content) {
                console.log(`   ⚠️ Skipping invalid: missing fields`);
                continue;
              }

              const hash = hashContent(article.title, article.url);
              if (history.hashes.includes(hash)) {
                console.log(`   ⏭️ Already posted: ${article.title.substring(0, 40)}`);
                continue;
              }

              articles.push({
                title: article.title,
                content: article.content,
                url: article.url,
                source: article.source || site,
                hash
              });
            } catch (e) {
              console.warn(`   ⚠️ Error: ${e.message}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Site error: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`❌ Cannot read ${dataDir}: ${e.message}`);
      console.error("Make sure scraper_repo is cloned in the GitHub Actions workflow");
      process.exit(1);
    }

    // Sort by content length (quality proxy)
    articles.sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));

    console.log(`\n✨ Found ${articles.length} new articles\n`);

    if (articles.length === 0) {
      console.log("⚠️ No new articles to post");
      return;
    }

    // Post up to 2 articles per run
    const toPost = articles.slice(0, 2);
    let posted = 0;

    for (let i = 0; i < toPost.length; i++) {
      const article = toPost[i];
      console.log("=".repeat(70));
      console.log(`📰 Article ${i + 1}/${toPost.length}: ${article.title.substring(0, 60)}`);
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
            console.log(`⚠️ Attempt ${attempt}/3 failed, retrying...`);
            await new Promise(r => setTimeout(r, 2000));
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
            access_token: process.env.FB_PAGE_TOKEN 
          }
        );

        if (res.data.id) {
          console.log(`✅ Posted! ${res.data.id}\n`);
          history.hashes.push(article.hash);
          history.count = (history.count || 0) + 1;
          posted++;

          // Wait before next post
          if (i < toPost.length - 1) {
            console.log("⏳ Waiting 10 seconds before next post...");
            await new Promise(r => setTimeout(r, 10000));
          }
        } else {
          console.error("❌ No post ID returned\n");
        }
      } catch (e) {
        console.error(`❌ Error: ${e.message}\n`);
      }
    }

    // Save and push
    await saveHistory(history);
    console.log("=".repeat(70));
    console.log(`✅ BOT COMPLETE - Posted ${posted} articles`);
    console.log("=".repeat(70) + "\n");

    try {
      execSync('git config --global user.name "GitHub Actions Bot"', { stdio: 'pipe' });
      execSync('git config --global user.email "bot@github.com"', { stdio: 'pipe' });
      execSync('git add posted_history.json', { stdio: 'pipe' });
      execSync(`git commit -m "Bot posted ${posted} articles" || true`, { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✅ Pushed changes to GitHub\n");
    } catch (e) {
      console.warn(`⚠️ Git error: ${e.message}\n`);
    }

  } catch (e) {
    console.error(`\n❌ FATAL ERROR: ${e.message}`);
    process.exit(1);
  }
}

runBot().catch(console.error);
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const path = require("path");
const { execSync } = require('child_process');

async function runBot() {
  // ============ VALIDATION ============
  const requiredEnvVars = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash"
  });

  // ============ POSTED HISTORY - NEW ============
  
  async function loadPostedHistory() {
    try {
      const historyPath = path.join(process.cwd(), "posted_history.json");
      const data = await fs.readFile(historyPath, "utf8");
      return JSON.parse(data);
    } catch (err) {
      console.log(`📝 Creating new posted_history.json`);
      return {
        urls: [],
        titles: [],
        lastUpdated: new Date().toISOString(),
        totalPosted: 0
      };
    }
  }

  async function savePostedHistory(history) {
    try {
      const historyPath = path.join(process.cwd(), "posted_history.json");
      await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
      console.log(`✅ Posted history saved (${history.urls.length} URLs tracked)`);
    } catch (err) {
      console.error(`❌ Error saving posted_history.json: ${err.message}`);
    }
  }

  function isUrlAlreadyPosted(history, articleUrl) {
    return history.urls.includes(articleUrl);
  }

  function isTitleAlreadyPosted(history, articleTitle) {
    const titleHash = generateTitleHash(articleTitle);
    return history.titles.includes(titleHash);
  }

  async function addToPostedHistory(history, article) {
    const titleHash = generateTitleHash(article.title);
    
    if (!history.urls.includes(article.url)) {
      history.urls.push(article.url);
    }
    if (!history.titles.includes(titleHash)) {
      history.titles.push(titleHash);
    }
    
    history.totalPosted += 1;
    history.lastUpdated = new Date().toISOString();
    
    await savePostedHistory(history);
  }

  // ============ HELPER FUNCTIONS ============
  
  function generateContentHash(title, content) {
    const normalized = `${title}${content.substring(0, 1000)}`.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  function generateTitleHash(title) {
    const normalized = title.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  function extractKeywords(text) {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);
    return new Set(words.slice(0, 15));
  }

  function keywordSimilarity(keywords1, keywords2) {
    const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
    const union = new Set([...keywords1, ...keywords2]);
    return intersection.size / union.size;
  }

  // ============ STORY TYPE CLASSIFICATION ============

  async function classifyArticleRelationship(newArticle, fbPost) {
    console.log(`\n   🤖 Analyzing article relationship...`);
    
    const classifyPrompt = `
You are a news editor. Classify the relationship between TWO news items about SIMILAR topics.

CURRENT ARTICLE:
Title: ${newArticle.title}
Content: ${newArticle.content.substring(0, 600)}

PREVIOUSLY POSTED (on Facebook):
Title: ${fbPost.message.split('\n')[0]}
Content: ${fbPost.message.substring(0, 600)}

Classify the relationship:

EXACT_DUPLICATE: If they report the EXACT SAME event/announcement (same facts, same day)
  Example: "Bank cuts rates 2.5%" (April 10) vs "Banks lower rates 2.5%" (April 10)
  
FOLLOW_UP: If this is a CONTINUATION/UPDATE of the previous story
  Example: "Bank cuts rates" (April 10) vs "Banks explain rate cuts impact" (April 11)
  Signs: Later date, updates on consequences, reaction, next steps, official response
  
RELATED_DIFFERENT: If they are RELATED but DIFFERENT news on similar topics
  Example: "Bank cuts rates" (April 10) vs "Inflation drops" (April 12)
  Signs: Different events, similar topic, different dates (> 2 days)
  
NEW_ANGLE: If it's a NEW ANGLE/DEEPER ANALYSIS of same event
  Example: "Government policy announced" (April 10) vs "How policy will affect citizens" (April 11)
  Signs: Same core event, but exploring different aspects/impact/analysis

RESPOND ONLY WITH ONE WORD:
- EXACT_DUPLICATE
- FOLLOW_UP
- RELATED_DIFFERENT
- NEW_ANGLE

Be strict: only EXACT_DUPLICATE if reporting the SAME event with SAME facts.`;

    try {
      const classifyResult = await model.generateContent(classifyPrompt);
      const classification = classifyResult.response.text().trim().toUpperCase();
      
      console.log(`   Classification: ${classification}`);
      
      return {
        type: classification,
        isExactDuplicate: classification === "EXACT_DUPLICATE"
      };
    } catch (err) {
      console.warn(`   ⚠️ Classification failed: ${err.message}`);
      return {
        type: "UNKNOWN",
        isExactDuplicate: false
      };
    }
  }

  // ============ FACEBOOK OPERATIONS ============

  async function fetchFacebookPosts() {
    console.log(`\n📱 Fetching your Facebook posts...`);
    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_TOKEN;
    
    try {
      const url = `https://graph.facebook.com/v20.0/${pageId}/feed`;
      const params = {
        fields: 'message,created_time,id',
        access_token: token,
        limit: 100
      };

      const response = await axios.get(url, { params });
      const posts = response.data.data || [];
      
      console.log(`✅ Retrieved ${posts.length} posts from Facebook`);
      
      if (posts.length > 0) {
        console.log(`\n📋 Recent posts on Facebook:`);
        posts.slice(0, 5).forEach((post, i) => {
          const date = new Date(post.created_time).toLocaleDateString();
          const preview = post.message?.substring(0, 80) || "[No message]";
          console.log(`   ${i + 1}. [${date}] ${preview}...`);
        });
      }
      
      return posts;
    } catch (err) {
      console.error(`❌ Failed to fetch Facebook posts: ${err.message}`);
      throw err;
    }
  }

  async function analyzeArticleRelationship(article, facebookPosts) {
    console.log(`\n🔍 Checking for related content on Facebook...`);
    
    const articleKeywords = extractKeywords(`${article.title} ${article.content}`);
    console.log(`   Article: "${article.title.substring(0, 70)}..."`);
    
    // Find most similar Facebook post
    let mostSimilarPost = null;
    let highestSimilarity = 0;
    let relationship = null;

    for (const fbPost of facebookPosts) {
      if (!fbPost.message) continue;

      const fbKeywords = extractKeywords(fbPost.message);
      const similarity = keywordSimilarity(articleKeywords, fbKeywords);
      const fbDate = new Date(fbPost.created_time);
      const daysSincePost = (new Date() - fbDate) / (1000 * 60 * 60 * 24);

      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        mostSimilarPost = {
          message: fbPost.message,
          created_time: fbPost.created_time,
          daysSince: daysSincePost,
          similarity: similarity
        };
      }
    }

    if (!mostSimilarPost) {
      console.log(`   ✅ No related posts found`);
      return {
        isExactDuplicate: false,
        type: "NEW_STORY",
        allowPost: true
      };
    }

    console.log(`\n   Found related post from ${mostSimilarPost.daysSince.toFixed(1)} days ago`);
    console.log(`   Title: "${mostSimilarPost.message.split('\n')[0].substring(0, 70)}..."`);
    console.log(`   Keyword match: ${(mostSimilarPost.similarity * 100).toFixed(0)}%`);

    // If low similarity, it's a different story
    if (mostSimilarPost.similarity < 0.40) {
      console.log(`   ✅ Low similarity - Different story`);
      return {
        isExactDuplicate: false,
        type: "DIFFERENT_STORY",
        allowPost: true
      };
    }

    // If very old (>7 days), allow even if similar
    if (mostSimilarPost.daysSince > 7) {
      console.log(`   ✅ Old post (${mostSimilarPost.daysSince.toFixed(0)} days) - Can repost similar`);
      return {
        isExactDuplicate: false,
        type: "OLD_STORY_REVIVAL",
        allowPost: true
      };
    }

    // Use AI to classify relationship
    console.log(`\n   🤖 Using AI to understand relationship...`);
    const classification = await classifyArticleRelationship(article, mostSimilarPost);

    // Decision rules based on classification
    let decision = {
      isExactDuplicate: classification.isExactDuplicate,
      type: classification.type,
      allowPost: false,
      reason: ""
    };

    if (classification.type === "EXACT_DUPLICATE") {
      decision.allowPost = false;
      decision.reason = "Exact duplicate of recent post";
      console.log(`   ❌ EXACT DUPLICATE - Will skip`);
    } else if (classification.type === "FOLLOW_UP") {
      decision.allowPost = true;
      decision.reason = "Follow-up article on same story";
      console.log(`   ✅ FOLLOW-UP ARTICLE - Will post`);
    } else if (classification.type === "NEW_ANGLE") {
      decision.allowPost = true;
      decision.reason = "New angle/analysis of same story";
      console.log(`   ✅ NEW ANGLE - Will post`);
    } else if (classification.type === "RELATED_DIFFERENT") {
      decision.allowPost = true;
      decision.reason = "Related but different story";
      console.log(`   ✅ RELATED STORY - Will post`);
    } else {
      decision.allowPost = true;
      decision.reason = "Unknown relationship but safe to post";
      console.log(`   ⚠️ Unknown type - Posting as different story`);
    }

    return decision;
  }

  // ============ POST LOGGING ============

  async function loadPostLog() {
    try {
      const logPath = path.join(process.cwd(), "post_log.json");
      const data = await fs.readFile(logPath, "utf8");
      return JSON.parse(data);
    } catch (err) {
      return {
        posts: [],
        total: 0,
        by_source: {},
        by_date: {},
        by_type: {}
      };
    }
  }

  async function savePostLog(log) {
    try {
      const logPath = path.join(process.cwd(), "post_log.json");
      await fs.writeFile(logPath, JSON.stringify(log, null, 2));
      console.log(`✅ Post log updated`);
    } catch (err) {
      console.error(`❌ Failed to save post log: ${err.message}`);
    }
  }

  async function addToPostLog(article, facebookPostId, facebookPost, articleType) {
    const log = await loadPostLog();
    const today = new Date().toISOString().split('T')[0];
    
    const logEntry = {
      date: new Date().toISOString(),
      fb_post_id: facebookPostId,
      source: article.site,
      url: article.url,
      title: article.title,
      article_type: articleType,
      content_hash: generateContentHash(article.title, article.content),
      facebook_message: facebookPost.substring(0, 200)
    };

    log.posts.push(logEntry);
    log.total = log.posts.length;
    
    if (!log.by_source[article.site]) {
      log.by_source[article.site] = 0;
    }
    log.by_source[article.site]++;
    
    if (!log.by_date[today]) {
      log.by_date[today] = 0;
    }
    log.by_date[today]++;

    if (!log.by_type[articleType]) {
      log.by_type[articleType] = 0;
    }
    log.by_type[articleType]++;

    await savePostLog(log);
  }

  async function generatePostSummary() {
    const log = await loadPostLog();
    
    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 POST SUMMARY`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Total posts: ${log.total}`);
    
    if (Object.keys(log.by_source).length > 0) {
      console.log(`\n📰 Posts by Source:`);
      Object.entries(log.by_source).forEach(([source, count]) => {
        console.log(`   ${source}: ${count} posts`);
      });
    }

    if (Object.keys(log.by_type).length > 0) {
      console.log(`\n📋 Posts by Type:`);
      Object.entries(log.by_type).forEach(([type, count]) => {
        console.log(`   ${type}: ${count} posts`);
      });
    }
    
    if (Object.keys(log.by_date).length > 0) {
      console.log(`\n📅 Posts by Date:`);
      Object.entries(log.by_date).slice(-7).forEach(([date, count]) => {
        console.log(`   ${date}: ${count} posts`);
      });
    }

    if (log.posts.length > 0) {
      console.log(`\n📋 Last 3 Posts:`);
      log.posts.slice(-3).forEach((entry, i) => {
        const date = new Date(entry.date).toLocaleDateString();
        console.log(`   ${i + 1}. [${date}] ${entry.title.substring(0, 60)}...`);
        console.log(`      Type: ${entry.article_type} | Source: ${entry.source}`);
      });
    }
  }

  // ============ MAIN LOGIC ============

  try {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`🤖 INTELLIGENT NEWS BOT - WITH FOLLOW-UP DETECTION`);
    console.log(`${"=".repeat(70)}`);
    console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

    // Load posted history - NEW
    const postedHistory = await loadPostedHistory();
    console.log(`\n📝 Loaded posted history: ${postedHistory.urls.length} URLs already posted`);

    // Fetch Facebook posts
    let facebookPosts = [];
    try {
      facebookPosts = await fetchFacebookPosts();
    } catch (err) {
      console.warn(`⚠️ Warning: Could not fetch Facebook posts`);
    }

    // Fetch news from local scraper repo
    console.log(`\n📡 Reading news from local scraper repo...`);
    const dataDir = './scraper_repo/data';
    const sites = await fs.readdir(dataDir);

    let allArticles = [];
    let skippedDuplicates = 0;

    for (const siteName of sites) {
      const sitePath = `${dataDir}/${siteName}`;
      const stat = await fs.stat(sitePath);
      if (!stat.isDirectory()) continue;
      
      console.log(`\n${"=".repeat(70)}`);
      console.log(`📂 Processing: ${siteName}`);
      console.log(`${"=".repeat(70)}`);
      
      try {
        const dates = await fs.readdir(sitePath);
        const latestDate = dates
          .filter(d => !d.startsWith('.'))
          .sort((a, b) => b.localeCompare(a))[0];
        
        if (!latestDate) continue;
        
        const datePath = `${sitePath}/${latestDate}`;
        const files = await fs.readdir(datePath);
        
        for (const fileName of files) {
          if (!fileName.endsWith('.json')) continue;
          
          try {
            const filePath = `${datePath}/${fileName}`;
            const content = await fs.readFile(filePath, 'utf8');
            const article = JSON.parse(content);
            
            console.log(`\n   📰 "${article.title.substring(0, 70)}..."`);
            
            // ====== NEW: Check against posted history ======
            if (isUrlAlreadyPosted(postedHistory, article.url)) {
              console.log(`   ⏭️ SKIPPING - Already posted (URL in history)`);
              skippedDuplicates++;
              continue;
            }

            if (isTitleAlreadyPosted(postedHistory, article.title)) {
              console.log(`   ⏭️ SKIPPING - Already posted (Title in history)`);
              skippedDuplicates++;
              continue;
            }
            // ====== END NEW ======
            
            // Analyze relationship to existing posts
            const analysis = await analyzeArticleRelationship(article, facebookPosts);
            
            if (analysis.isExactDuplicate) {
              console.log(`   ⏭️ SKIPPING - ${analysis.reason}`);
              skippedDuplicates++;
              continue;
            }
            
            if (!analysis.allowPost) {
              console.log(`   ⏭️ SKIPPING - ${analysis.reason}`);
              skippedDuplicates++;
              continue;
            }
            
            console.log(`   ✅ NEW/FOLLOW-UP - Adding to queue`);
            
            allArticles.push({
              ...article,
              site: siteName,
              priority: article.content.length > 1500 ? 3 : article.content.length > 800 ? 2 : 1,
              articleType: analysis.type
            });
          } catch (fileErr) {
            console.warn(`   ⚠️ Error: ${fileErr.message}`);
          }
        }
      } catch (siteErr) {
        console.warn(`   ⚠️ Error processing site: ${siteErr.message}`);
      }
    }

    // Deduplicate within allArticles
    const seenTitles = new Set();
    const deduplicatedArticles = [];
    
    allArticles.sort((a, b) => b.priority - a.priority);

    for (const article of allArticles) {
      const titleHash = generateTitleHash(article.title);
      if (!seenTitles.has(titleHash)) {
        seenTitles.add(titleHash);
        deduplicatedArticles.push(article);
      }
    }

    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 FILTERING RESULTS`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Total new articles found: ${allArticles.length}`);
    console.log(`Skipped as exact duplicates: ${skippedDuplicates}`);
    console.log(`Unique articles ready: ${deduplicatedArticles.length}`);

    if (deduplicatedArticles.length === 0) {
      console.log(`\n⚠️ No new articles to post.`);
      await generatePostSummary();
      return;
    }

    // Process up to 2 articles
    const articlesToPost = deduplicatedArticles.slice(0, 2);
    let postedCount = 0;

    for (const article of articlesToPost) {
      console.log(`\n${"=".repeat(70)}`);
      console.log(`📰 PROCESSING ARTICLE`);
      console.log(`${"=".repeat(70)}`);
      console.log(`Title: ${article.title}`);
      console.log(`Source: ${article.site}`);
      console.log(`URL: ${article.url}`);
      console.log(`Type: ${article.articleType || "NEW_STORY"}`);
      console.log(`Priority: ${'⭐'.repeat(article.priority)}`);

      // Assess interest
      const assessPrompt = `
You are a news editor. Rate if this article is INTERESTING for Facebook.

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Respond ONLY with: INTERESTING or SKIP`;

    const assessResult = await model.generateContent(assessPrompt);
    const assessment = assessResult.response.text().trim().toUpperCase();

    console.log(`\n🔍 Assessment: ${assessment}`);

    if (!assessment.includes("INTERESTING")) {
      console.log(`⏭️ Skipping - Not interesting enough`);
      await generatePostSummary();
      return;
    }

    // Create post
    console.log(`\n✍️ Creating Facebook post...`);
    
    const detailPrompt = `
You are a professional Nepali news writer for Facebook.

ARTICLE: ${article.title}
CONTENT: ${article.content}
URL: ${article.url}
SOURCE: ${article.site}

Create an ENGAGING Facebook post in Nepali & English:

1. Start with 🚨 and bold headline in Nepali
2. Write 5-7 clear sentences with FULL story details
3. Include: Who, What, When, Where, Why, What's next
4. Mix Nepali and English naturally
5. Use emojis
6. MUST include: 🔗 Read Full Story: ${article.url}
7. Add 3-4 hashtags
8. Make it 600-900 characters

FORMAT:
🚨 **नेपालीमा शीर्षक**

विस्तृत विवरण (5-7 वाक्य)...

📌 मुख्य बिन्दु:
• बिन्दु १
• बिन्दु २
• बिन्दु ३

🔗 Read Full Story: ${article.url}
📰 Source: ${article.site}

#NepalNews #tag1 #tag2`;

    let contentResult;
    let retries = 3;
    for (let i = 0; i < retries; i++) {
      try {
        contentResult = await model.generateContent(detailPrompt);
        break;
      } catch (error) {
        console.log(`API error (attempt ${i+1}/${retries}): ${error.message}`);
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          throw error;
        }
      }
    }
    let facebookPost = contentResult.response.text().trim();

    console.log(`\n📝 Generated Post:`);
    console.log(`${"=".repeat(70)}`);
    console.log(facebookPost);
    console.log(`${"=".repeat(70)}`);

    if (facebookPost.length < 150) {
      console.log(`❌ Post too short`);
      return;
    }

    if (!facebookPost.includes(article.url)) {
      facebookPost += `\n\n🔗 Read Full Story: ${article.url}\n📰 Source: ${article.site}`;
    }

    // Post to Facebook
    console.log(`\n📤 Posting to Facebook...`);
    
    const fbUrl = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`;
    const payload = {
      message: facebookPost,
      access_token: process.env.FB_PAGE_TOKEN
    };

    const response = await axios.post(fbUrl, payload);

    if (response.data.id) {
      console.log(`\n✅ SUCCESS! Post ID: ${response.data.id}`);
      console.log(`✅ URL: https://facebook.com/${response.data.id}`);
      
      // ====== NEW: Add to both logs ======
      await addToPostLog(article, response.data.id, facebookPost, article.articleType || "NEW_STORY");
      await addToPostedHistory(postedHistory, article);
      postedCount++;
      // ====== END NEW ======
    } else {
      console.error(`❌ Failed to post`);
      throw new Error("No post ID returned");
    }

    await generatePostSummary();

    console.log(`\n${"=".repeat(70)}`);
    console.log(`🎉 Bot completed successfully!`);
    console.log(`${"=".repeat(70)}\n`);
    }

    // Commit and push changes
    try {
      execSync('git config --global user.name "GitHub Actions Bot"');
      execSync('git config --global user.email "bot@github.com"');
      execSync('git add posted_history.json');
      execSync('git commit -m "Update posted history after posting ' + postedCount + ' articles" || echo "No changes"');
      execSync('git push');
      console.log('✅ Committed and pushed updated posted history');
    } catch (error) {
      console.error('❌ Failed to commit changes:', error.message);
    }

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run
(async () => {
  await startBot();
})();
