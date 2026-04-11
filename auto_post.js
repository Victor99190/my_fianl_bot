const { GoogleGenerativeAI } = require("@google/generative-ai");

async function startBot() {
  console.log("🚀 SCRIPT STARTING...");

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
  const FB_PAGE_ID = process.env.FB_PAGE_ID;

  const NEWS_SOURCES = [
    "https://kathmandupost.com/national",
    "https://thehimalayantimes.com/nepal"
  ];

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  
  // UPDATED MODEL NAME FOR 2026
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  for (const url of NEWS_SOURCES) {
    try {
      console.log(`📰 Reading News: ${url}`);
      
      const prompt = `तपाईं एक अनुभवी नेपाली पत्रकार हो। यो लिंक (${url}) बाट मुख्य समाचार छनोट गरी २ वाक्यमा व्यवसायीक नेपाली युनिकोड (Unicode) मा फेसबुक पोस्ट लेख्नुहोस्। पोस्टमा २ वटा इमोजी र लिंक समावेश गर्नुहोस्।`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      
      console.log("🤖 Summary generated. Posting to Facebook...");

      const res = await fetch(`https://graph.facebook.com/v20.0/${FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, access_token: FB_PAGE_TOKEN })
      });
      
      const data = await res.json();
      console.log("📡 Facebook Response:", JSON.stringify(data));
    } catch (e) {
      console.error("❌ ERROR inside loop:", e.message);
    }
  }
}

(async () => {
    await startBot();
    console.log("🏁 SCRIPT FINISHED.");
})();
