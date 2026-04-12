const { GoogleGenerativeAI } = require("@google/generative-ai");

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
    // Note: url_context is NOT a standard tool - removed to avoid issues
  });

  const NEWS_SOURCES = [
    "https://www.onlinekhabar.com",
    "https://ekantipur.com",
    "https://www.setopati.com",
    "https://www.nepalpress.com",
    "https://www.ratopati.com"
  ];

  const source = NEWS_SOURCES[Math.floor(Math.random() * NEWS_SOURCES.length)];

  const prompt = `
You are a professional Nepali news editor. Today is April 11, 2026.

TASK: Imagine you are visiting ${source} and finding the most IMPORTANT current news story.
Since you cannot actually browse, create a realistic Nepali news post based on what major news typically comes from Nepal.

RULES:
1. Only create posts about MAJOR news (Politics, National, Breaking, Economy, Health).
2. Do NOT create posts about minor news, gossip, ads, or sports.
3. If you cannot think of a major news story, output exactly: SKIP
4. Do NOT include any extra text, explanations, or preamble.
5. Format EXACTLY like this (no variations):

🚨 **[मुख्य शीर्षकमा नेपालीमा - कैची वा समसामयिक विषय]**

[पेशादार २-वाक्यको सारांश नेपालीमा Unicode मा - स्पष्ट र सूचनात्मक]

स्रोत: ${source}
#NepalNews #[प्रासंगिक_विषय]

Example format (do NOT use this exact text):
🚨 **नेपालमा नयाँ आर्थिक नीति घोषणा**

राष्ट्र बैंकले नयाँ आर्थिक नीति घोषणा गरेको छ। यो नीतिले विदेशी विनियोगलाई प्रोत्साहन गर्नेछ।

स्रोत: ${source}
#NepalNews #अर्थनीति
`;

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
        const article = content; // axios parses JSON automatically
        
        if (!postedUrls.includes(article.url)) {
          allArticles.push({
            ...article,
            site: site.name,
            priority: article.content.length > 1000 ? 2 : 1 // Longer content = higher priority
          });
        }
      }
    }

    // Sort by priority and date
    allArticles.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(b.scraped_at) - new Date(a.scraped_at);
    });

    console.log(`📊 Found ${allArticles.length} new articles`);

    // Process up to 5 articles
    const toPost = allArticles.slice(0, 5);
    let postedCount = 0;

    for (const article of toPost) {
      try {
        console.log(`\n📰 Processing: ${article.title.substring(0, 50)}...`);
        
        // Summarize with Gemini
        const prompt = `
You are a friendly Nepali news enthusiast sharing important updates.

ARTICLE TITLE: ${article.title}
ARTICLE CONTENT: ${article.content.substring(0, 2000)}...

Create a human-like Facebook post in Nepali and English:
- Start with 🚨 and bold title
- 2-3 engaging sentences
- Mix Nepali and English naturally
- Add relevant emoji
- End with source and hashtags
- Keep under 300 characters
- Sound conversational, like a real person sharing news

Example:
🚨 **Big news from Nepal!**

नेपालमा नयाँ कानुन आएको छ। This new law will help farmers a lot! 🌾

स्रोत: ${article.site}
#NepalNews #Important
`;

        const result = await model.generateContent(prompt);
        const summary = result.response.text().trim();

        console.log(`📝 Summary:\n${summary}\n`);

        if (summary === "SKIP" || summary.length < 20) {
          console.log("⏭️ Skipped: Summary too short");
          continue;
        }

        // Post to Facebook
        console.log(`📤 Posting to Facebook...`);
        
        const fbUrl = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`;
        const payload = {
          message: summary,
          access_token: process.env.FB_PAGE_TOKEN
        };

        const response = await axios.post(fbUrl, payload);
        const responseData = response.data;

        if (responseData.id) {
          console.log(`✅ Posted! ID: ${responseData.id}`);
          postedUrls.push(article.url);
          postedCount++;
          
          // Save posted URLs
          await fs.writeFile("posted_urls.json", JSON.stringify(postedUrls, null, 2));
        } else {
          console.warn(`⚠️ No post ID returned`);
        }

        // Rate limit: 1 post per 10 seconds
        await new Promise(resolve => setTimeout(resolve, 10000));

      } catch (error) {
        console.error(`❌ Error processing article: ${error.message}`);
      }
    }

    console.log(`\n🎉 Bot finished! Posted ${postedCount} articles.`);

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
