import json
import os
from datetime import datetime
from typing import Optional

from config import STATE_FILE

def load_last_processed() -> Optional[str]:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            data = json.load(f)
            return data.get('last_processed')
    return None

def save_last_processed(timestamp: str):
    with open(STATE_FILE, 'w') as f:
        json.dump({'last_processed': timestamp}, f)