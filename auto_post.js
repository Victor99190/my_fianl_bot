const { GoogleGenerativeAI } = require("@google/generative-ai");

async function startBot() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    tools: [{ url_context: {} }] 
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
    Context: You are a professional Nepali news editor. Today is April 11, 2026.
    Task: Visit ${source} and find the most IMPORTANT news.
    
    RULES:
    1. Only post if it is major news (Politics, National, Breaking). 
    2. If it is minor, gossip, or an ad, output "SKIP".
    3. Do NOT include any introductory or concluding text. Just the news.
    4. Format exactly like this:
       🚨 [Catchy Headline in Bold Nepali]
       
       [Professional 2-sentence summary in Nepali Unicode]
       
       स्रोत: https://www.cnn.com/
       #NepalNews #[RelevantTopic]
  `;

  try {
    console.log(`📡 Checking ${source}...`);
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    if (text !== "SKIP" && text.length > 20) {
      await fetch(`https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, access_token: process.env.FB_PAGE_TOKEN })
      });
      console.log("✅ Posted successfully!");
    } else {
      console.log("⏭️ Filtered: News was too minor to post.");
    }
  } catch (e) {
    console.error("❌ System Error:", e.message);
  }
}

(async () => { await startBot(); })();
