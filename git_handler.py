import os
import subprocess
from git import Repo
from config import REPO_PATH, REPO_URL

def ensure_repo():
    if not os.path.exists(REPO_PATH):
        print("Cloning repository...")
        Repo.clone_from(REPO_URL, REPO_PATH)
    else:
        print("Pulling latest changes...")
        repo = Repo(REPO_PATH)
        repo.remotes.origin.pull()

def get_repo_path():
    return REPO_PATH