import sys
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="session-token-bypass"
)

def run_test():
    print("Testing connection to Gemini Web-Bridge...")
    try:
        response = client.chat.completions.create(
            model="gemini-web",
            messages=[
                {"role": "system", "content": "You are a concise engineering assistant."},
                {"role": "user", "content": "ขอ 3 ข้อดีของการรันโปรโตคอลบริดจ์ในระบบท้องถิ่น"}
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
        print(f"\n[ERROR] Connection failed: {e}")

if __name__ == "__main__":
    run_test()
