#!/usr/bin/env node

/**
 * Quick validation script to test:
 * 1. Environment variables are set
 * 2. Gemini API key works
 * 3. Facebook token is valid
 * 4. Facebook page ID is accessible
 */

const https = require('https');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(status, message) {
  const symbol = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⏳';
  const color = status === 'pass' ? colors.green : status === 'fail' ? colors.red : colors.yellow;
  console.log(`${color}${symbol} ${message}${colors.reset}`);
}

async function validateEnv() {
  console.log(`\n${colors.blue}=== Environment Variables ===${colors.reset}\n`);
  
  const checks = [
    { name: 'GEMINI_API_KEY', env: process.env.GEMINI_API_KEY },
    { name: 'FB_PAGE_TOKEN', env: process.env.FB_PAGE_TOKEN },
    { name: 'FB_PAGE_ID', env: process.env.FB_PAGE_ID }
  ];

  let allPresent = true;
  for (const check of checks) {
    if (check.env) {
      const preview = check.env.substring(0, 10) + '...' + check.env.substring(check.env.length - 4);
      log('pass', `${check.name}: ${preview}`);
    } else {
      log('fail', `${check.name}: NOT SET`);
      allPresent = false;
    }
  }

  if (!allPresent) {
    console.log(`\n${colors.red}❌ Missing environment variables. Set them in GitHub Secrets or .env file${colors.reset}\n`);
    process.exit(1);
  }
}

async function testGeminiAPI() {
  console.log(`\n${colors.blue}=== Testing Gemini API ===${colors.reset}\n`);
  
  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const result = await model.generateContent("Say 'Gemini is working' in one word");
    const text = result.response.text().trim();
    
    if (text.length > 0) {
      log('pass', `Gemini API works. Response: "${text}"`);
      return true;
    }
  } catch (error) {
    log('fail', `Gemini API error: ${error.message}`);
    return false;
  }
}

async function testFacebookToken() {
  console.log(`\n${colors.blue}=== Testing Facebook Token ===${colors.reset}\n`);
  
  return new Promise((resolve) => {
    const url = `https://graph.facebook.com/v20.0/me?access_token=${process.env.FB_PAGE_TOKEN}`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            log('fail', `Facebook token invalid: ${json.error.message}`);
            if (json.error.code === 190) {
              console.log(`${colors.yellow}💡 Token expired or invalid. Regenerate from Graph API Explorer${colors.reset}`);
            }
            resolve(false);
          } else {
            log('pass', `Facebook token valid. User: ${json.name}`);
            resolve(true);
          }
        } catch (e) {
          log('fail', `Failed to parse response: ${e.message}`);
          resolve(false);
        }
      });
    }).on('error', (err) => {
      log('fail', `Network error: ${err.message}`);
      resolve(false);
    });
  });
}

async function testFacebookPageAccess() {
  console.log(`\n${colors.blue}=== Testing Facebook Page Access ===${colors.reset}\n`);
  
  return new Promise((resolve) => {
    const url = `https://graph.facebook.com/v20.0/${process.env.FB_PAGE_ID}?access_token=${process.env.FB_PAGE_TOKEN}`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            log('fail', `Cannot access page ${process.env.FB_PAGE_ID}: ${json.error.message}`);
            if (json.error.code === 104) {
              console.log(`${colors.yellow}💡 Token missing permissions. Add "pages_manage_posts" in app settings${colors.reset}`);
            }
            resolve(false);
          } else {
            log('pass', `Page accessible. Name: ${json.name}`);
            resolve(true);
          }
        } catch (e) {
          log('fail', `Failed to parse response: ${e.message}`);
          resolve(false);
        }
      });
    }).on('error', (err) => {
      log('fail', `Network error: ${err.message}`);
      resolve(false);
    });
  });
}

async function main() {
  console.log(`\n${colors.blue}╔════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║  Facebook News Bot - Validation Suite  ║${colors.reset}`);
  console.log(`${colors.blue}╚════════════════════════════════════════╝${colors.reset}`);

  try {
    // 1. Validate environment variables
    await validateEnv();

    // 2. Test Gemini API
    const geminiOk = await testGeminiAPI();

    // 3. Test Facebook Token
    const tokenOk = await testFacebookToken();

    // 4. Test Facebook Page Access
    const pageOk = await testFacebookPageAccess();

    // Summary
    console.log(`\n${colors.blue}=== Summary ===${colors.reset}\n`);
    
    if (geminiOk && tokenOk && pageOk) {
      console.log(`${colors.green}✅ All checks passed! You're ready to run the bot.${colors.reset}\n`);
      console.log(`Run: ${colors.yellow}npm start${colors.reset} or ${colors.yellow}node auto_post.js${colors.reset}\n`);
      process.exit(0);
    } else {
      console.log(`${colors.red}❌ Some checks failed. Fix the issues above and try again.${colors.reset}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n${colors.red}Fatal error: ${error.message}${colors.reset}\n`);
    process.exit(1);
  }
}

main();
