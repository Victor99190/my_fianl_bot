async function postToFacebook() {
  // Use "gemini-1.5-flash-latest" to avoid 404 errors
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

  for (const url of NEWS_SOURCES) {
    try {
      console.log(`Processing: ${url}`);
      
      // I've added a instruction to ensure it doesn't just return an empty string
      const prompt = `Task: Visit ${url} and summarize the top news. 
      Write a catchy Facebook post with 2 emojis and the link. 
      Keep it under 50 words. Do not include introductory text.`;
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const message = response.text();

      if (!message) {
        console.log("Gemini returned an empty message. Skipping...");
        continue;
      }

      const res = await fetch(`https://graph.facebook.com/v20.0/${FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: message, 
          access_token: FB_PAGE_TOKEN 
        })
      });
      
      const data = await res.json();
      if (data.id) {
        console.log(`✅ Posted successfully! ID: ${data.id}`);
      } else {
        console.log(`❌ Facebook Error: ${data.error.message}`);
      }
    } catch (e) {
      console.error(`Failed ${url}:`, e.message);
    }
  }
}
