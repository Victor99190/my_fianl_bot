const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const path = require("path");

async function startBot() {
  // ============ VALIDATION ============
  const requiredEnvVars = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite-preview"
  });

  // ============ HELPER FUNCTIONS ============
  
  function generateContentHash(title, content) {
    const normalized = `${title}${content.substring(0, 500)}`.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  function generateTopicHash(title, content) {
    // More lenient hash - focuses on main topic
    const normalized = `${title.split(' ').slice(0, 5).join(' ')}`.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
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
        limit: 100  // Get last 100 posts
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
      if (err.response?.data?.error) {
        console.error(`   Error details: ${err.response.data.error.message}`);
      }
      throw err;
    }
  }

  function extractTitleFromPost(message) {
    // Extract the title line (usually first line after emoji)
    const lines = message.split('\n');
    const titleLine = lines.find(line => line.includes('**')) || lines[0];
    return titleLine?.replace(/\*\*/g, '').trim().substring(0, 100) || '';
  }

  function isDuplicatePost(article, facebookPosts) {
    const articleHash = generateContentHash(article.title, article.content);
    const articleTopicHash = generateTopicHash(article.title, article.content);

    console.log(`\n🔍 Checking Facebook history for duplicates...`);
    console.log(`   Article hash: ${articleHash}`);
    console.log(`   Article topic: ${articleTopicHash}`);

    let exactDuplicate = false;
    let similarTopicCount = 0;

    for (const fbPost of facebookPosts) {
      if (!fbPost.message) continue;

      const fbHash = generateContentHash(fbPost.message, fbPost.message);
      const fbTopicHash = generateTopicHash(fbPost.message, fbPost.message);
      const fbDate = new Date(fbPost.created_time);
      const daysSincePost = (new Date() - fbDate) / (1000 * 60 * 60 * 24);

      // Check for exact duplicate
      if (fbHash === articleHash) {
        console.log(`   ❌ EXACT DUPLICATE FOUND!`);
        console.log(`      Posted ${daysSincePost.toFixed(1)} days ago`);
        exactDuplicate = true;
        break;
      }

      // Check for same topic (but allow if > 5 days old)
      if (fbTopicHash === articleTopicHash && daysSincePost < 5) {
        console.log(`   ⚠️  Similar topic found (${daysSincePost.toFixed(1)} days ago)`);
        similarTopicCount++;
      }
    }

    console.log(`   Summary: ${exactDuplicate ? '❌ EXACT MATCH' : '✅ UNIQUE ARTICLE'}`);
    if (similarTopicCount > 0) {
      console.log(`   Note: ${similarTopicCount} similar topic(s) posted recently`);
    }

    return {
      isExactDuplicate: exactDuplicate,
      similarTopicCount,
      isDuplicate: exactDuplicate
    };
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
        by_date: {}
      };
    }
  }

  async function savePostLog(log) {
    try {
      const logPath = path.join(process.cwd(), "post_log.json");
      await fs.writeFile(logPath, JSON.stringify(log, null, 2));
      console.log(`✅ Post log updated: ${log.posts.length} entries`);
    } catch (err) {
      console.error(`❌ Failed to save post log: ${err.message}`);
    }
  }

  async function addToPostLog(article, facebookPostId, facebookPost) {
    const log = await loadPostLog();
    const today = new Date().toISOString().split('T')[0];
    
    const logEntry = {
      date: new Date().toISOString(),
      fb_post_id: facebookPostId,
      source: article.site,
      url: article.url,
      title: article.title,
      content_hash: generateContentHash(article.title, article.content),
      topic_hash: generateTopicHash(article.title, article.content),
      facebook_message: facebookPost.substring(0, 200) + "..." // Preview
    };

    log.posts.push(logEntry);
    log.total = log.posts.length;
    
    // Track by source
    if (!log.by_source[article.site]) {
      log.by_source[article.site] = 0;
    }
    log.by_source[article.site]++;
    
    // Track by date
    if (!log.by_date[today]) {
      log.by_date[today] = 0;
    }
    log.by_date[today]++;

    await savePostLog(log);
    
    return logEntry;
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
        console.log(`      Source: ${entry.source}`);
        console.log(`      FB Post: ${entry.fb_post_id}`);
      });
    }
  }

  // ============ MAIN LOGIC ============

  try {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`🤖 SMART NEWS BOT - WITH FACEBOOK HISTORY CHECK`);
    console.log(`${"=".repeat(70)}`);
    console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

    // Fetch Facebook posts first
    let facebookPosts = [];
    try {
      facebookPosts = await fetchFacebookPosts();
    } catch (err) {
      console.warn(`⚠️ Warning: Could not fetch Facebook posts, continuing without dedup check`);
      console.warn(`   Make sure your token has the 'pages_read_user_content' permission`);
    }

    // Load post log
    const postLog = await loadPostLog();

    // Fetch news
    console.log(`\n📡 Fetching news from scraper...`);
    const repoApi = "https://api.github.com/repos/Victor99190/final-scrapeer/contents/data";
    const { data: sites } = await axios.get(repoApi);

    let allArticles = [];
    let skippedDuplicates = 0;

    for (const site of sites) {
      if (site.type !== "dir") continue;
      
      console.log(`\n${"=".repeat(70)}`);
      console.log(`📂 Processing: ${site.name}`);
      console.log(`${"=".repeat(70)}`);
      
      try {
        const { data: dates } = await axios.get(site.url);
        const latestDate = dates
          .filter(d => d.type === "dir")
          .sort((a, b) => b.name.localeCompare(a.name))[0];
        
        if (!latestDate) continue;
        
        const { data: files } = await axios.get(latestDate.url);
        
        for (const file of files) {
          if (!file.name.endsWith(".json")) continue;
          
          try {
            const { data: content } = await axios.get(file.download_url);
            const article = content;
            
            console.log(`\n   📰 "${article.title.substring(0, 70)}..."`);
            
            // Check if already posted on Facebook
            const dupeCheck = isDuplicatePost(article, facebookPosts);
            
            if (dupeCheck.isDuplicate) {
              console.log(`   ⏭️ SKIPPING - Already on Facebook`);
              skippedDuplicates++;
              continue;
            }
            
            // Check if in local post log
            const inLog = postLog.posts.some(p => 
              p.content_hash === generateContentHash(article.title, article.content)
            );
            
            if (inLog) {
              console.log(`   ⏭️ SKIPPING - In local post log`);
              skippedDuplicates++;
              continue;
            }
            
            console.log(`   ✅ NEW - Adding to queue`);
            
            allArticles.push({
              ...article,
              site: site.name,
              contentHash: generateContentHash(article.title, article.content),
              priority: article.content.length > 1500 ? 3 : article.content.length > 800 ? 2 : 1
            });
          } catch (fileErr) {
            console.warn(`⚠️ Error processing file: ${fileErr.message}`);
          }
        }
      } catch (siteErr) {
        console.warn(`⚠️ Error processing site: ${siteErr.message}`);
      }
    }

    // Remove duplicates within allArticles (same hash)
    const seenHashes = new Set();
    const deduplicatedArticles = [];
    
    allArticles.sort((a, b) => b.priority - a.priority);

    for (const article of allArticles) {
      if (!seenHashes.has(article.contentHash)) {
        seenHashes.add(article.contentHash);
        deduplicatedArticles.push(article);
      }
    }

    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 FILTERING RESULTS`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Total new articles found: ${allArticles.length}`);
    console.log(`Skipped as duplicates: ${skippedDuplicates}`);
    console.log(`Unique articles ready: ${deduplicatedArticles.length}`);

    if (deduplicatedArticles.length === 0) {
      console.log(`\n⚠️ No new articles to post. Running summary instead.`);
      await generatePostSummary();
      return;
    }

    // Take the first (best) article
    const article = deduplicatedArticles[0];

    console.log(`\n${"=".repeat(70)}`);
    console.log(`📰 PROCESSING ARTICLE`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Title: ${article.title}`);
    console.log(`Source: ${article.site}`);
    console.log(`URL: ${article.url}`);
    console.log(`Priority: ${'⭐'.repeat(article.priority)}`);

    // Assess interest
    const assessPrompt = `
You are a news editor. Rate if this article is INTERESTING and worth posting on Facebook.

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Respond ONLY with: INTERESTING or SKIP

Be strict - only INTERESTING news (politics, economy, health, major events).`;

    const assessResult = await model.generateContent(assessPrompt);
    const assessment = assessResult.response.text().trim().toUpperCase();

    console.log(`\n🔍 Interest Assessment: ${assessment}`);

    if (!assessment.includes("INTERESTING")) {
      console.log(`⏭️ Not interesting enough. Skipping.`);
      await generatePostSummary();
      return;
    }

    // Create Facebook post
    console.log(`\n✍️ Creating Facebook post...`);
    
    const detailPrompt = `
You are a professional Nepali news writer for Facebook.

ARTICLE: ${article.title}
CONTENT: ${article.content}
URL: ${article.url}
SOURCE: ${article.site}

Create an ENGAGING Facebook post in Nepali & English:

REQUIREMENTS:
1. Start with 🚨 and bold headline in Nepali
2. Write 5-7 clear sentences with FULL story details
3. Include: Who, What, When, Where, Why, What's next
4. Mix Nepali and English naturally
5. Use emojis for key points
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

#NepalNews #relevant_tag
`;

    const contentResult = await model.generateContent(detailPrompt);
    let facebookPost = contentResult.response.text().trim();

    console.log(`\n📝 Generated Post:`);
    console.log(`${"=".repeat(70)}`);
    console.log(facebookPost);
    console.log(`${"=".repeat(70)}`);

    // Validate
    if (facebookPost.length < 150) {
      console.log(`❌ Post too short`);
      return;
    }

    if (!facebookPost.includes(article.url)) {
      console.log(`⚠️ Adding source link...`);
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
      
      // Log this post
      await addToPostLog(article, response.data.id, facebookPost);
      
      console.log(`\n💾 Post logged and tracked`);
    } else {
      console.error(`❌ Failed to post`);
      throw new Error("No post ID returned");
    }

    // Show summary
    await generatePostSummary();

    console.log(`\n${"=".repeat(70)}`);
    console.log(`🎉 Bot completed successfully!`);
    console.log(`${"=".repeat(70)}\n`);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.response?.data?.error) {
      console.error(`   Details: ${JSON.stringify(error.response.data.error)}`);
    }
    process.exit(1);
  }
}

// Run
(async () => {
  await startBot();
})();
