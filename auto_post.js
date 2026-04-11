const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;

// ADD YOUR NEWS LINKS HERE
const NEWS_SOURCES = [
  "https://kathmandupost.com/national",
  "https://thehimalayantimes.com/nepal"
];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function postToFacebook() {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  for (const url of NEWS_SOURCES) {
    try {
      console.log(`Processing: ${url}`);
      const prompt = `Visit ${url}. Find the top headline. Write a short, engaging Facebook post about it with emojis and 2 hashtags. Include the link.`;
      
      const result = await model.generateContent(prompt);
      const message = result.response.text();

      const res = await fetch(`https://graph.facebook.com/v20.0/${FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, access_token: FB_PAGE_TOKEN })
      });
      
      const data = await res.json();
      console.log(data.id ? `✅ Posted news from ${url}` : `❌ Error: ${data.error.message}`);
    } catch (e) {
      console.error(`Failed ${url}:`, e.message);
    }
  }
}

postToFacebook();
