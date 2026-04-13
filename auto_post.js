const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");

async function startBot() {
  // ============ VALIDATION ============
  const requiredEnvVars = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("Set these in GitHub Secrets or .env file");
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite-preview"
  });

  const NEWS_SOURCES = [
    "https://www.onlinekhabar.com",
    "https://ekantipur.com",
    "https://www.setopati.com",
    "https://www.nepalpress.com",
    "https://www.ratopati.com"
  ];

  // ============ HELPER FUNCTIONS ============
  
  // Generate content hash to detect duplicates even from different sources
  function generateContentHash(title, content) {
    const normalized = `${title}${content.substring(0, 500)}`.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  // Load tracking data
  async function loadTracking() {
    try {
      const data = await fs.readFile("news_tracking.json", "utf8");
      return JSON.parse(data);
    } catch (err) {
      return {
        posted_urls: [],
        posted_hashes: [],
        posted_at: [],
        last_run: null,
        total_posted: 0
      };
    }
  }

  // Save tracking data
  async function saveTracking(tracking) {
    await fs.writeFile("news_tracking.json", JSON.stringify(tracking, null, 2));
  }

  // Check if article is already posted (by URL or content hash)
  function isAlreadyPosted(article, tracking) {
    const contentHash = generateContentHash(article.title, article.content);
    
    return {
      byUrl: tracking.posted_urls.includes(article.url),
      byHash: tracking.posted_hashes.includes(contentHash),
      contentHash
    };
  }

  // Extract domain from URL
  function getDomain(url) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      return domain;
    } catch {
      return 'unknown';
    }
  }

  try {
    console.log(`\n🔄 Starting bot at ${new Date().toISOString()}`);
    
    // Load tracking data
    const tracking = await loadTracking();
    console.log(`📊 Previously posted: ${tracking.total_posted} articles`);

    // Fetch scraped news from GitHub
    console.log(`📡 Fetching scraped news from final-scrapeer repo...`);
    const repoApi = "https://api.github.com/repos/Victor99190/final-scrapeer/contents/data";
    const { data: sites } = await axios.get(repoApi);

    let allArticles = [];

    for (const site of sites) {
      if (site.type !== "dir") continue;
      console.log(`📂 Processing site: ${site.name}`);
      
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
            
            // Check for duplicates
            const dupeCheck = isAlreadyPosted(article, tracking);
            if (dupeCheck.byUrl || dupeCheck.byHash) {
              console.log(`⏭️ Skipping duplicate: ${article.title.substring(0, 50)}...`);
              continue;
            }
            
            allArticles.push({
              ...article,
              site: site.name,
              contentHash: dupeCheck.contentHash,
              domain: getDomain(article.url),
              // Priority based on content length and recency
              priority: article.content.length > 1500 ? 3 : article.content.length > 800 ? 2 : 1,
              scraped_timestamp: new Date(article.scraped_at).getTime()
            });
          } catch (fileErr) {
            console.warn(`⚠️ Error processing file ${file.name}:`, fileErr.message);
          }
        }
      } catch (siteErr) {
        console.warn(`⚠️ Error processing site ${site.name}:`, siteErr.message);
      }
    }

    // Remove duplicate content (keep highest priority version)
    const seenHashes = new Set();
    const deduplicatedArticles = [];
    
    allArticles.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.scraped_timestamp - a.scraped_timestamp;
    });

    for (const article of allArticles) {
      if (!seenHashes.has(article.contentHash)) {
        seenHashes.add(article.contentHash);
        deduplicatedArticles.push(article);
      } else {
        console.log(`🔄 Duplicate content found: ${article.title.substring(0, 50)}...`);
      }
    }

    console.log(`📊 Found ${deduplicatedArticles.length} unique new articles`);

    if (deduplicatedArticles.length === 0) {
      console.log("⚠️ No new articles to post");
      tracking.last_run = new Date().toISOString();
      await saveTracking(tracking);
      return;
    }

    // Process the first (best) article
    const article = deduplicatedArticles[0];

    try {
      console.log(`\n📰 Processing: ${article.title}`);
      console.log(`📊 Priority Score: ${article.priority}`);
      console.log(`📍 Source: ${article.site}`);
      console.log(`🔗 URL: ${article.url}`);
      
      // Assess if the article is interesting
      const assessPrompt = `
You are a news editor for a Nepal news Facebook page. Rate if this article is INTERESTING and worth posting.

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Respond ONLY with a single word:
- INTERESTING: If it covers major news (politics, economy, health, national importance, major events)
- SKIP: If it's minor, gossip, sports, ads, celebrity news, or not newsworthy

Be strict - only post IMPORTANT news that people care about.`;

      const assessResult = await model.generateContent(assessPrompt);
      const assessment = assessResult.response.text().trim().toUpperCase();

      console.log(`\n🔍 Assessment: ${assessment}`);

      if (!assessment.includes("INTERESTING")) {
        console.log("⏭️ Article not interesting enough. Skipping to next.");
        tracking.posted_urls.push(article.url);
        tracking.posted_hashes.push(article.contentHash);
        await saveTracking(tracking);
        return;
      }

      // Create detailed Facebook post with source link
      console.log(`\n✍️ Creating detailed post...`);
      
      const detailPrompt = `
You are a professional Nepali news writer for a Facebook news page. Create an engaging, factual post.

ARTICLE TITLE: ${article.title}
ARTICLE CONTENT: ${article.content}
ARTICLE URL: ${article.url}
SOURCE: ${article.site}

Create a DETAILED, ENGAGING Facebook post in Nepali & English mix:

REQUIREMENTS:
1. Start with 🚨 and bold headline in Nepali
2. Write 5-7 clear sentences with FULL story details
3. Include specific facts, numbers, names, context
4. Naturally mix Nepali and English
5. Use emojis to highlight key points
6. Include the SOURCE LINK at the end (very important!)
7. Add 3-4 relevant hashtags
8. Make it 600-900 characters - SUBSTANTIAL and INFORMATIVE

FACTS TO VERIFY:
- Who is involved? (names, roles)
- What happened? (specific events)
- When did it happen? (dates, timing)
- Where? (locations)
- Why is it important? (impact, implications)
- What comes next? (consequences, follow-up)

FORMAT EXAMPLE:
🚨 **नेपालीमा शीर्षक**

विस्तृत विवरण (5-7 वाक्य नेपाली/English मिश्रण)। सब विवरण समावेश गर्नुहोस्।

📌 मुख्य बिन्दु:
• बिन्दु १ - विशिष्ट विवरण
• बिन्दु २ - विशिष्ट विवरण
• बिन्दु ३ - विशिष्ट विवरण

🔗 Read Full Story: ${article.url}
📰 Source: ${article.site}

#NepalNews #relevant_topic #News

TONE: Professional, trustworthy, informative - like a news friend sharing important updates.
BE FACTUAL - only include information from the article provided.`;

      const contentResult = await model.generateContent(detailPrompt);
      const facebookPost = contentResult.response.text().trim();

      console.log(`\n📝 Generated Post:\n`);
      console.log(`${"=".repeat(70)}`);
      console.log(facebookPost);
      console.log(`${"=".repeat(70)}\n`);

      // Validate post
      if (facebookPost.length < 150) {
        console.log("⚠️ Post too short, skipping");
        tracking.posted_urls.push(article.url);
        tracking.posted_hashes.push(article.contentHash);
        await saveTracking(tracking);
        return;
      }

      if (!facebookPost.includes(article.url)) {
        console.log("⚠️ Post missing source link, adding it...");
        const postWithLink = facebookPost + `\n\n🔗 पूरो खबर पढ्न: ${article.url}`;
        facebookPost = postWithLink;
      }

      // Post to Facebook
      console.log(`\n📤 Posting to Facebook...`);
      
      const fbUrl = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`;
      const payload = {
        message: facebookPost,
        access_token: process.env.FB_PAGE_TOKEN
      };

      try {
        const response = await axios.post(fbUrl, payload);
        const responseData = response.data;

        if (responseData.id) {
          console.log(`\n✅ SUCCESS! Post ID: ${responseData.id}`);
          console.log(`🎉 Article posted successfully!`);
          
          // Mark as posted
          tracking.posted_urls.push(article.url);
          tracking.posted_hashes.push(article.contentHash);
          tracking.posted_at.push(new Date().toISOString());
          tracking.total_posted++;
          await saveTracking(tracking);
          
          console.log(`\n💾 Tracking updated`);
          console.log(`📊 Total posted: ${tracking.total_posted}`);
        } else if (responseData.error) {
          console.error(`❌ Facebook API Error:`, responseData.error);
          throw new Error(responseData.error.message);
        } else {
          console.warn(`⚠️ Unexpected response from Facebook API`);
          console.warn(`Response:`, responseData);
        }
      } catch (fbError) {
        console.error(`\n❌ Facebook posting failed: ${fbError.message}`);
        if (fbError.response?.data?.error) {
          console.error(`API Error Details:`, fbError.response.data.error);
        }
        throw fbError;
      }

    } catch (error) {
      console.error(`\n❌ Error processing article: ${error.message}`);
      console.error(error.stack);
      throw error;
    }

    console.log(`\n🎉 Bot cycle completed!`);

  } catch (error) {
    console.error(`\n❌ System Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the bot
(async () => {
  await startBot();
})();
