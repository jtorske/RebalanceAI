import os
import logging
from typing import Optional

import httpx

logger = logging.getLogger("rebalanceai")

_GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"


def call_groq(prompt: str, timeout: int = 20, max_tokens: int = 400, caller: str = "") -> Optional[str]:
    """
    Send a prompt to Groq and return the response text.
    Returns None if the key is missing, the call fails, or the response is empty.
    All failures are logged as warnings and swallowed — callers must supply their
    own deterministic fallback.
    """
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        logger.warning("GROQ_API_KEY not set — skipping Groq call%s", f" [{caller}]" if caller else "")
        return None

    model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip()
    tag = f" [{caller}]" if caller else ""
    logger.info("Groq call starting%s: model=%s max_tokens=%d", tag, model, max_tokens)

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
        if text:
            logger.info("Groq call succeeded%s: model=%s chars=%d", tag, model, len(text))
            return text
        logger.warning("Groq call returned empty response%s", tag)
        return None
    except httpx.HTTPStatusError as err:
        logger.warning("Groq API HTTP error %s%s: %s", err.response.status_code, tag, err)
        return None
    except Exception as err:
        logger.warning("Groq API call failed%s: %s", tag, err)
        return None


def get_groq_model() -> str:
    return os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip()
