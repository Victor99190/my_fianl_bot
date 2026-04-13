const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const path = require("path");
const { execSync } = require('child_process');

async function runBot() {
  console.log("\n" + "=".repeat(70));
  console.log("🚀 NEPAL NEWS BOT - Starting");
  console.log("=".repeat(70) + "\n");

  // Validate env vars
  const required = ["GEMINI_API_KEY", "FB_PAGE_TOKEN", "FB_PAGE_ID"];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Utility: Generate content hash
  function hashContent(title, url) {
    return crypto.createHash('md5').update(`${title}||${url}`).digest('hex');
  }

  // Load history
  async function loadHistory() {
    try {
      const filePath = './posted_history.json';
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return { hashes: [], count: 0 };
    }
  }

  // Save history
  async function saveHistory(hist) {
    await fs.writeFile('./posted_history.json', JSON.stringify(hist, null, 2));
  }

  try {
    const history = await loadHistory();
    console.log(`📊 Loaded history: ${history.hashes.length} articles tracked\n`);

    // Read scraper data
    const dataDir = './scraper_repo/data';
    let articles = [];

    try {
      const sites = await fs.readdir(dataDir);
      
      for (const site of sites) {
        const sitePath = `${dataDir}/${site}`;
        try {
          const stat = await fs.stat(sitePath);
          if (!stat.isDirectory()) continue;

          const dates = await fs.readdir(sitePath);
          const latestDate = dates.filter(d => !d.startsWith('.')).sort().reverse()[0];
          if (!latestDate) continue;

          const files = await fs.readdir(`${sitePath}/${latestDate}`);
          console.log(`📂 ${site}/${latestDate}: ${files.filter(f => f.endsWith('.json')).length} files`);

          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const data = await fs.readFile(`${sitePath}/${latestDate}/${file}`, 'utf8');
              const article = JSON.parse(data);

              // Validate
              if (!article.title || !article.url || !article.content) {
                console.log(`   ⚠️ Skipping invalid: missing fields`);
                continue;
              }

              const hash = hashContent(article.title, article.url);
              if (history.hashes.includes(hash)) {
                console.log(`   ⏭️ Already posted: ${article.title.substring(0, 40)}`);
                continue;
              }

              articles.push({
                title: article.title,
                content: article.content,
                url: article.url,
                source: article.source || site,
                hash
              });
            } catch (e) {
              console.warn(`   ⚠️ Error: ${e.message}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Site error: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`❌ Cannot read ${dataDir}: ${e.message}`);
      console.error("Make sure scraper_repo is cloned in the GitHub Actions workflow");
      process.exit(1);
    }

    // Sort by content length (quality proxy)
    articles.sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));

    console.log(`\n✨ Found ${articles.length} new articles\n`);

    if (articles.length === 0) {
      console.log("⚠️ No new articles to post");
      return;
    }

    // Post up to 2 articles per run
    const toPost = articles.slice(0, 2);
    let posted = 0;

    for (let i = 0; i < toPost.length; i++) {
      const article = toPost[i];
      console.log("=".repeat(70));
      console.log(`📰 Article ${i + 1}/${toPost.length}: ${article.title.substring(0, 60)}`);
      console.log("=".repeat(70));

      try {
        // Summarize with retries
        let summary;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const prompt = `In 2-3 sentences, summarize this Nepali news for Facebook. Be engaging and informative:

TITLE: ${article.title}
CONTENT: ${article.content.substring(0, 1500)}

Reply with ONLY the summary, nothing else.`;

            const result = await model.generateContent(prompt);
            summary = result.response.text().trim();

            if (summary && summary.length > 20) {
              console.log("✅ Summarized");
              break;
            }
          } catch (e) {
            if (attempt === 3) throw e;
            console.log(`⚠️ Attempt ${attempt}/3 failed, retrying...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!summary || summary.length < 20) {
          console.error("❌ Failed to generate summary");
          continue;
        }

        const post = `🚨 **${article.title}**

${summary}

📰 Source: ${article.source}
🔗 Read more: ${article.url}

#NepalNews #Breaking`;

        // Post to Facebook
        console.log("📤 Posting to Facebook...");
        const res = await axios.post(
          `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}/feed`,
          { 
            message: post, 
            access_token: process.env.FB_PAGE_TOKEN 
          }
        );

        if (res.data.id) {
          console.log(`✅ Posted! ${res.data.id}\n`);
          history.hashes.push(article.hash);
          history.count = (history.count || 0) + 1;
          posted++;

          // Wait before next post
          if (i < toPost.length - 1) {
            console.log("⏳ Waiting 10 seconds before next post...");
            await new Promise(r => setTimeout(r, 10000));
          }
        } else {
          console.error("❌ No post ID returned\n");
        }
      } catch (e) {
        console.error(`❌ Error: ${e.message}\n`);
      }
    }

    // Save and push
    await saveHistory(history);
    console.log("=".repeat(70));
    console.log(`✅ BOT COMPLETE - Posted ${posted} articles`);
    console.log("=".repeat(70) + "\n");

    try {
      execSync('git config --global user.name "GitHub Actions Bot"', { stdio: 'pipe' });
      execSync('git config --global user.email "bot@github.com"', { stdio: 'pipe' });
      execSync('git add posted_history.json', { stdio: 'pipe' });
      execSync(`git commit -m "Bot posted ${posted} articles" || true`, { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✅ Pushed changes to GitHub\n");
    } catch (e) {
      console.warn(`⚠️ Git error: ${e.message}\n`);
    }

  } catch (e) {
    console.error(`\n❌ FATAL ERROR: ${e.message}`);
    process.exit(1);
  }
}

runBot().catch(console.error);
