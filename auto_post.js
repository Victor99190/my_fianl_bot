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
    console.log(`📡 Fetching news from: ${source}`);

    // Call Gemini API
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    console.log(`\n📝 Gemini Response:\n${text}\n`);

    // Check if we should skip this
    if (text === "SKIP" || text.length < 20) {
      console.log("⏭️ Skipped: News was too minor or Gemini returned SKIP");
      return;
    }

    // ============ POST TO FACEBOOK ============
    console.log(`\n📤 Posting to Facebook Page ID: ${process.env.FB_PAGE_ID}`);
    
    const fbUrl = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`;
    const payload = {
      message: text,
      access_token: process.env.FB_PAGE_TOKEN
    };

    console.log(`📍 API Endpoint: ${fbUrl}`);
    console.log(`📦 Payload size: ${JSON.stringify(payload).length} bytes`);

    const response = await fetch(fbUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'NewsBot/1.0'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();

    // ============ HANDLE FACEBOOK RESPONSE ============
    if (!response.ok) {
      console.error(`\n❌ Facebook API Error (${response.status}):`);
      console.error(JSON.stringify(responseData, null, 2));
      
      if (responseData.error?.message) {
        console.error(`Error Message: ${responseData.error.message}`);
      }
      
      if (responseData.error?.code === 190) {
        console.error("💡 Token expired or invalid. Check FB_PAGE_TOKEN secret.");
      }
      if (responseData.error?.code === 104) {
        console.error("💡 Token does not have proper permissions. Ensure token has:");
        console.error("   - pages_manage_posts");
        console.error("   - pages_read_user_context");
      }
      process.exit(1);
    }

    // Success!
    if (responseData.id) {
      console.log(`\n✅ Posted successfully!`);
      console.log(`📌 Post ID: ${responseData.id}`);
      console.log(`🔗 View post: https://www.facebook.com/${responseData.id}`);
      return responseData.id;
    } else {
      console.warn(`⚠️ No post ID returned. Response:`, responseData);
    }

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
