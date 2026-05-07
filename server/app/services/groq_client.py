import os
import logging
from typing import Optional

import httpx

logger = logging.getLogger("rebalanceai")

_GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"


def call_groq(prompt: str, timeout: int = 20, max_tokens: int = 400) -> Optional[str]:
    """
    Send a prompt to Groq and return the response text.
    Returns None if the key is missing, the call fails, or the response is empty.
    All failures are logged as warnings and swallowed — callers must supply their
    own deterministic fallback.
    """
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        logger.debug("GROQ_API_KEY not set — skipping Groq call")
        return None

    model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip()

    try:
        resp = httpx.post(
            _GROQ_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": max_tokens,
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"].strip()
        return text or None
    except httpx.HTTPStatusError as err:
        logger.warning("Groq API HTTP error %s: %s", err.response.status_code, err)
        return None
    except Exception as err:
        logger.warning("Groq API call failed: %s", err)
        return None
