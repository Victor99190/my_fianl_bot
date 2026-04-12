const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;

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

  try {
    console.log(`\n🔄 Starting bot at ${new Date().toISOString()}`);
    
    // Load posted URLs
    let postedUrls = [];
    try {
      const data = await fs.readFile("posted_urls.json", "utf8");
      postedUrls = JSON.parse(data);
    } catch (err) {
      console.log("📄 No posted URLs file found, starting fresh");
    }

    // Fetch scraped news from GitHub
    console.log(`📡 Fetching scraped news from final-scrapeer repo...`);
    const repoApi = "https://api.github.com/repos/Victor99190/final-scrapeer/contents/data";
    const { data: sites } = await axios.get(repoApi);

    let allArticles = [];

    for (const site of sites) {
      if (site.type !== "dir") continue;
      console.log(`📂 Processing site: ${site.name}`);
      
      const { data: dates } = await axios.get(site.url);
      const latestDate = dates
        .filter(d => d.type === "dir")
        .sort((a, b) => b.name.localeCompare(a.name))[0]; // Latest date
      
      if (!latestDate) continue;
      
      const { data: files } = await axios.get(latestDate.url);
      for (const file of files) {
        if (!file.name.endsWith(".json")) continue;
        
        const { data: content } = await axios.get(file.download_url);
        const article = content;
        
        if (!postedUrls.includes(article.url)) {
          allArticles.push({
            ...article,
            site: site.name,
            // Priority based on content length (longer = more substantial)
            priority: article.content.length > 1500 ? 3 : article.content.length > 800 ? 2 : 1
          });
        }
      }
    }

    // Sort by priority (highest first) and date
    allArticles.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(b.scraped_at) - new Date(a.scraped_at);
    });

    console.log(`📊 Found ${allArticles.length} new articles`);

    if (allArticles.length === 0) {
      console.log("⚠️ No new articles to post");
      return;
    }

    // Take ONLY the first (most interesting) article
    const article = allArticles[0];

    try {
      console.log(`\n📰 Processing: ${article.title}`);
      console.log(`📊 Priority Score: ${article.priority}`);
      console.log(`📍 Source: ${article.site}`);
      
      // First, assess if the article is interesting enough
      const assessPrompt = `
You are a news editor. Rate if this article is INTERESTING and worth posting on Facebook.

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Respond ONLY with:
- INTERESTING: If it covers major news (politics, economy, health, national importance)
- SKIP: If it's minor, gossip, sports, ads, or not newsworthy

Be strict - only INTERESTING news.`;

      const assessResult = await model.generateContent(assessPrompt);
      const assessment = assessResult.response.text().trim();

      console.log(`\n🔍 Assessment: ${assessment}`);

      if (assessment === "SKIP") {
        console.log("⏭️ Article not interesting enough. Skipping.");
        // Still mark as posted to avoid re-processing
        postedUrls.push(article.url);
        await fs.writeFile("posted_urls.json", JSON.stringify(postedUrls, null, 2));
        return;
      }

      // Create detailed Facebook post
      console.log(`\n✍️ Creating detailed post...`);
      
      const detailPrompt = `
You are a professional Nepali news writer creating engaging Facebook posts.

ARTICLE TITLE: ${article.title}
ARTICLE CONTENT: ${article.content}

Create a DETAILED, ENGAGING Facebook post in Nepali with English (mixed naturally):

STRUCTURE:
1. Start with 🚨 and a bold, catchy headline in Nepali
2. Write 4-6 detailed sentences explaining the full story
3. Include key details, context, and implications
4. Use natural mix of Nepali and English
5. Add relevant emojis throughout
6. End with source name and 2-3 relevant hashtags

TONE: Professional but conversational, like a trusted news friend sharing updates

CONSTRAINTS:
- Make it SUBSTANTIAL and INFORMATIVE (500-800 characters)
- Sound natural and engaging
- Include actual details from the article
- Be factual and clear

Format:
🚨 **[नेपालीमा आकर्षक शीर्षक]**

[विस्तृत वर्णन - 4-6 वाक्य नेपाली र English मिलाएर। सबै महत्त्वपूर्ण बिवरण समावेश गर्नुहोस्।]

📌 Key Points:
• [मुख्य बिन्दु १]
• [मुख्य बिन्दु २]
• [मुख्य बिन्दु ३]

Source: ${article.site}
#NepalNews #[प्रासंगिक_विषय]
`;

      const contentResult = await model.generateContent(detailPrompt);
      const facebookPost = contentResult.response.text().trim();

      console.log(`\n📝 Generated Post:\n`);
      console.log(`${"=".repeat(60)}`);
      console.log(facebookPost);
      console.log(`${"=".repeat(60)}\n`);

      // Validate post length
      if (facebookPost.length < 100) {
        console.log("⚠️ Post too short, skipping");
        return;
      }

      // Post to Facebook
      console.log(`\n📤 Posting to Facebook...`);
      
      const fbUrl = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`;
      const payload = {
        message: facebookPost,
        access_token: process.env.FB_PAGE_TOKEN
      };

      const response = await axios.post(fbUrl, payload);
      const responseData = response.data;

      if (responseData.id) {
        console.log(`\n✅ SUCCESS! Post ID: ${responseData.id}`);
        console.log(`🎉 Article posted successfully!`);
        
        // Mark as posted
        postedUrls.push(article.url);
        await fs.writeFile("posted_urls.json", JSON.stringify(postedUrls, null, 2));
        
        console.log(`\n💾 URL saved to posted_urls.json`);
        console.log(`📊 Total posted: ${postedUrls.length}`);
      } else {
        console.warn(`⚠️ No post ID returned from Facebook API`);
        console.warn(`Response:`, responseData);
      }

    } catch (error) {
      console.error(`\n❌ Error processing article: ${error.message}`);
      if (error.response?.data) {
        console.error(`API Error:`, error.response.data);
      }
      throw error;
    }

    console.log(`\n🎉 Bot completed! One article posted.`);

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
