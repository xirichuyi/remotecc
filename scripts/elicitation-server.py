"""Test-only stdio MCP server. No network and no external side effects."""
import json
import sys


def send(message):
    print(json.dumps(message), flush=True)


call_id = None
first = None
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    identifier = request.get('id')
    if method == 'initialize':
        send(dict(jsonrpc='2.0', id=identifier, result=dict(protocolVersion=request['params']['protocolVersion'], capabilities=dict(tools={}), serverInfo=dict(name='remotecc-test', version='1'))))
    elif method == 'tools/list':
        send(dict(jsonrpc='2.0', id=identifier, result=dict(tools=[dict(name='collect_preferences', description='Collect two user inputs for the RemoteCC integration test. Call exactly once.', inputSchema=dict(type='object', properties={}))])))
    elif method == 'tools/call':
        call_id = identifier
        send(dict(jsonrpc='2.0', id='form-one', method='elicitation/create', params=dict(message='First test form', requestedSchema=dict(type='object', properties=dict(name=dict(type='string', minLength=2), count=dict(type='integer', minimum=1, maximum=4), enabled=dict(type='boolean'), tags=dict(type='array', items=dict(type='string', enum=['a', 'b']), minItems=1)), required=['name', 'count', 'enabled', 'tags']))))
    elif method == 'ping':
        send(dict(jsonrpc='2.0', id=identifier, result={}))
    elif identifier == 'form-one':
        first = request.get('result')
        send(dict(jsonrpc='2.0', id='form-two', method='elicitation/create', params=dict(message='Second test form', requestedSchema=dict(type='object', properties=dict(confirm=dict(type='boolean')), required=['confirm']))))
    elif identifier == 'form-two':
        result = dict(first=first, second=request.get('result'))
        with open(sys.argv[1], 'w') as target:
            json.dump(result, target)
        send(dict(jsonrpc='2.0', id=call_id, result=dict(content=[dict(type='text', text='ELICITATION-TEST-DONE')], isError=False)))
