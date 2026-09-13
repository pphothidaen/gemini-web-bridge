"""Move existing client credentials into Worker secrets without printing values."""
import json
import re
import subprocess
from pathlib import Path
import yaml

config = yaml.safe_load((Path.home() / '.hermes/config.yaml').read_text())
provider = config['providers']['gemini-web-bridge']
client_key = provider.get('api_key') or config['model'].get('api_key')
extension = (Path(__file__).resolve().parents[2] / 'extension-cloudflare/content.js').read_text()
match = re.search(r'const DEFAULT_BRIDGE_SECRET = "([^"]+)"', extension)
if not client_key or not match:
    raise SystemExit('Existing credentials missing; no secrets changed')
result = subprocess.run(['wrangler','secret','bulk'], input=json.dumps({
    'BRIDGE_AUTH_TOKEN': match[1], 'CLIENT_API_TOKEN': client_key,
}), text=True, capture_output=True)
# Wrangler prints binding names only; suppress raw output defensively.
print(json.dumps({'secrets_updated': result.returncode == 0, 'exit_code': result.returncode}))
if result.returncode:
    print((result.stderr + result.stdout).replace(client_key, '[REDACTED]').replace(match[1], '[REDACTED]'))
raise SystemExit(result.returncode)
