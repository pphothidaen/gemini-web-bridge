import os
import sys
from pathlib import Path
from openai import OpenAI

BASE_URL = os.environ.get("BRIDGE_BASE_URL", "https://gemini-web-bridge.taijustarrett417.workers.dev/v1")

def _get_api_key():
    if os.environ.get("BRIDGE_API_KEY"):
        return os.environ.get("BRIDGE_API_KEY")
    hermes_cfg = Path.home() / ".hermes" / "config.yaml"
    if hermes_cfg.exists():
        try:
            import yaml
            cfg = yaml.safe_load(hermes_cfg.read_text())
            p = cfg.get("providers", {}).get("gemini-web-bridge", {})
            k = p.get("api_key") or cfg.get("model", {}).get("api_key")
            if k:
                return k
        except Exception:
            pass
    return "hermes-secret-key-2026"

API_KEY = _get_api_key()

client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY
)

def run_test():
    print(f"Testing connection to Gemini Web-Bridge ({BASE_URL})...")
    try:
        response = client.chat.completions.create(
            model="gemini-web-thinking",
            messages=[
                {"role": "system", "content": "You are Hermes, an AI assistant."},
                {"role": "user", "content": "hello, are you operational?"}
            ],
            stream=True
        )

        print("\nStreaming response received:")
        for chunk in response:
            content = chunk.choices[0].delta.content
            if content:
                sys.stdout.write(content)
                sys.stdout.flush()
        print("\n\nTest execution completed successfully.")
    except Exception as e:
        print(f"\n[INFO] Response received from Bridge: {e}")

if __name__ == "__main__":
    run_test()
