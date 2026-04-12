#!/usr/bin/env node

const axios = require('axios');

const requiredEnvVars = ['GEMINI_API_KEY', 'FB_PAGE_TOKEN', 'FB_PAGE_ID'];
const missing = requiredEnvVars.filter(name => !process.env[name]);

if (missing.length > 0) {
  console.error('Missing required environment variables: ' + missing.join(', '));
  process.exit(1);
}

console.log('Environment variables are set.');

async function validateFacebookToken() {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_TOKEN;
  const url = `https://graph.facebook.com/v20.0/${pageId}?fields=id&access_token=${token}`;

  try {
    const response = await axios.get(url);
    if (response.data && response.data.id) {
      console.log(`Facebook page validated: ${response.data.id}`);
      process.exit(0);
    }
  } catch (error) {
    console.error('Facebook validation failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

validateFacebookToken();
