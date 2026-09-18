"""Exercise the live browser with synthetic prompts and an in-memory tool."""
import json
from pathlib import Path
import urllib.request
import urllib.error
import yaml

cfg = yaml.safe_load((Path.home() / '.hermes/config.yaml').read_text())
provider = cfg['providers']['gemini-web-bridge']
base = provider['base_url'].rstrip('/')
headers = {'Authorization': 'Bearer ' + (provider.get('api_key') or cfg['model']['api_key']),
           'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json'}
report = {}

def request(path, body=None):
    req = urllib.request.Request(base + path, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)

try:
    catalog = request('/models')
    if not catalog.get('data'):
        raise RuntimeError('Browser model catalog is empty; open the Gemini model selector and retry.')
    model = catalog.get('default_recommended') or catalog['data'][0]['id']
    report.update(model=model, default_recommended=catalog.get('default_recommended'))
    plain = request('/chat/completions', {'model': model, 'messages': [
        {'role': 'user', 'content': 'Reply with exactly BRIDGE_OK.'}]})
    report['completion'] = plain
    assert 'BRIDGE_OK' in plain['choices'][0]['message'].get('content', '')
    tool = {'type': 'function', 'function': {'name': 'bridge_echo',
            'description': 'Return the supplied text.', 'parameters': {'type': 'object',
            'properties': {'text': {'type': 'string'}}, 'required': ['text'],
            'additionalProperties': False}}}
    messages = [{'role': 'user', 'content': 'Call bridge_echo with text TOOL_OK, then repeat its result.'}]
    first = request('/chat/completions', {'model': model, 'messages': messages,
                    'tools': [tool], 'tool_choice': 'required', 'parallel_tool_calls': False})
    report['tool_call'] = first
    assistant = first['choices'][0]['message']
    calls = assistant['tool_calls']
    assert len(calls) == 1 and calls[0]['function']['name'] == 'bridge_echo'
    args = json.loads(calls[0]['function']['arguments'])
    assert args == {'text': 'TOOL_OK'}
    messages.extend([assistant, {'role': 'tool', 'tool_call_id': calls[0]['id'], 'content': args['text']}])
    final = request('/chat/completions', {'model': model, 'messages': messages,
                    'tools': [tool], 'tool_choice': 'none'})
    report['tool_result_completion'] = final
    assert 'TOOL_OK' in final['choices'][0]['message'].get('content', '')
    assert not final['choices'][0]['message'].get('tool_calls')
    report['passed'] = True
except urllib.error.HTTPError as exc:
    report.update(passed=False, error={'status': exc.code, 'body': exc.read(1000).decode(errors='replace')})
    if 'required tool call' in report['error']['body']:
        try:
            report['auto_tool_diagnostic'] = request('/chat/completions', {
                'model': model, 'messages': messages, 'tools': [tool], 'tool_choice': 'auto'})
        except Exception as diagnostic_error:
            report['diagnostic_error'] = type(diagnostic_error).__name__
except Exception as exc:
    report.update(passed=False, error={'type': type(exc).__name__, 'message': str(exc)})
finally:
    Path('artifacts/live-chat-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
raise SystemExit(0 if report.get('passed') else 1)
