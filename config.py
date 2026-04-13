import os
from dotenv import load_dotenv

load_dotenv()

# GitHub repo details
REPO_URL = "https://github.com/Victor99190/final-scrapeer.git"
REPO_PATH = "scraper_repo"

# OpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = "gpt-3.5-turbo"  # Fast and cheap

# Facebook
FACEBOOK_ACCESS_TOKEN = os.getenv("FACEBOOK_ACCESS_TOKEN")
FACEBOOK_PAGE_ID = os.getenv("FACEBOOK_PAGE_ID")

# Bot settings
POSTS_PER_RUN = 2
STATE_FILE = "bot_state.json"