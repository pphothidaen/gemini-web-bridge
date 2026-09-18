"""Verify the installed Hermes provider wiring without starting a chat."""
import json
import sys
from pathlib import Path
root = Path.home()/'.hermes/hermes-agent'
sys.path.insert(0, str(root))
from hermes_cli.config import load_config
from hermes_cli.models import probe_api_models, cached_fetch_api_models
from hermes_cli.inventory import _apply_capabilities
cfg=load_config()
p=cfg['providers']['gemini-web-bridge']
key=p.get('api_key') or cfg['model'].get('api_key')
probe=probe_api_models(key,p['base_url'])
ids=cached_fetch_api_models(key,p['base_url'],cache_only=True)
rows=[{'slug':'gemini-web-bridge','models':list(ids or [])+[cfg['model']['default']]}]
_apply_capabilities(rows,cfg['providers'])
report={'main_default':cfg['model']['default'],'configured_models':p.get('models'), 'probe_succeeded':probe['models'] is not None,'live_models':probe['models'], 'refreshed_models':list(ids or []),'capabilities':rows[0]['capabilities']}
Path('artifacts/hermes-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
assert all(not cap['reasoning'] for cap in report['capabilities'].values())
assert probe['models'] is not None, 'Hermes live model probe failed'
