const { GoogleGenerativeAI } = require("@google/generative-ai");

console.log("🚀 SCRIPT STARTING..."); // Checkpoint 1

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;

const NEWS_SOURCES = [
  "https://kathmandupost.com/national",
  "https://thehimalayantimes.com/nepal"
];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function startBot() {
  console.log("🔗 Connecting to Gemini..."); // Checkpoint 2
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

  for (const url of NEWS_SOURCES) {
    try {
      console.log(`📰 Reading News: ${url}`);
      
      const prompt = `Identify the top headline from ${url} and write a professional Nepali Unicode Facebook post with 2 emojis and the link. Summarize in 2 sentences.`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      console.log("🤖 Gemini Summary Generated!"); // Checkpoint 3

      const res = await fetch(`https://graph.facebook.com/v20.0/${FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, access_token: FB_PAGE_TOKEN })
      });
      
      const data = await res.json();
      console.log("📡 Facebook Response:", JSON.stringify(data)); // Checkpoint 4
    } catch (e) {
      console.error("❌ ERROR:", e.message);
    }
  }
}

startBot().then(() => console.log("🏁 SCRIPT FINISHED."));
