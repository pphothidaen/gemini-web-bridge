"""Read-only production smoke checks; credentials are never written to evidence."""
import json
import urllib.request
import urllib.error
from pathlib import Path
import yaml

config = yaml.safe_load((Path.home() / '.hermes/config.yaml').read_text())
provider = config['providers']['gemini-web-bridge']
base = provider['base_url'].removesuffix('/v1').rstrip('/')
key = provider.get('api_key') or config['model'].get('api_key')
def get(path, auth=True):
    req = urllib.request.Request(base+path, headers={**({'Authorization': 'Bearer '+key} if auth else {}), 'User-Agent':'Mozilla/5.0', 'Cache-Control':'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return {'status':res.status, 'cache_control':res.headers.get('Cache-Control'), 'body':json.loads(res.read())}
    except urllib.error.HTTPError as exc:
        return {'status':exc.code, 'body_preview':exc.read(240).decode(errors='replace')}
report = {'health':get('/health',False), 'models':get('/v1/models'), 'unauthenticated_models':get('/v1/models',False), 'unauthenticated_websocket':get('/bridge',False)}
Path('artifacts/production-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
assert report['health']['body']['version']=='4.2.0'
assert report['models']['status']==200
assert report['models']['cache_control']=='no-store'
assert report['unauthenticated_models']['status']==401
assert report['unauthenticated_websocket']['status']==401
