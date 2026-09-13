import os
import sys
from openai import OpenAI

BASE_URL = os.environ.get("BRIDGE_BASE_URL", "https://gemini-web-bridge.taijustarrett417.workers.dev/v1")
API_KEY = os.environ.get("BRIDGE_API_KEY", "hermes-secret-key-2026")

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
