"""Redeem OAuth once on the browser computer; return the protected result over SSH.

No token, authorization code, or PKCE verifier is logged or stored locally.
Requires Python 3.10+ and Paramiko. SSH credentials come from the environment.
"""
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token'
CALLBACK = 'http://127.0.0.1:1455/auth/callback'
DIRECTORY = '/home/saad/workspaces/n8n-chatgpt-oauth/private/chatgpt-auth'
FILE_PATTERN = re.compile(r'exchange-([0-9a-f-]{36})\.request\.json\Z')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def validate(request, name):
    match = FILE_PATTERN.fullmatch(name)
    if not match or request.get('version') != 1 or request.get('id') != match[1]:
        raise ValueError('Invalid exchange envelope')
    if request.get('endpoint') != ENDPOINT or not isinstance(request.get('body'), str):
        raise ValueError('Invalid exchange endpoint')
    now = int(time.time() * 1000)
    if not now - 35000 < request.get('created_at', 0) <= now + 5000:
        raise ValueError('Stale exchange')
    if not now < request.get('expires_at', 0) <= now + 35000:
        raise ValueError('Expired exchange')
    fields = urllib.parse.parse_qs(request['body'], strict_parsing=True)
    allowed = {'grant_type','client_id','code','code_verifier','redirect_uri','resource'}
    required = allowed - {'resource'}
    if not required <= fields.keys() or not fields.keys() <= allowed:
        raise ValueError('Invalid exchange fields')
    if any(len(values) != 1 or not values[0] for values in fields.values()):
        raise ValueError('Ambiguous exchange fields')
    if fields['grant_type'][0] != 'authorization_code' or fields['redirect_uri'][0] != CALLBACK:
        raise ValueError('Invalid code grant')
    if not fields['client_id'][0].startswith('oaiapp_'):
        raise ValueError('Invalid client registration')
    if 'resource' in fields and fields['resource'][0] != 'https://api.openai.com/v1':
        raise ValueError('Invalid resource')
    if not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}', fields['code_verifier'][0]):
        raise ValueError('Invalid PKCE verifier')

def redeem(request):
    result = {'version':1, 'id':request['id'], 'status':503, 'body':'{}'}
    req = urllib.request.Request(ENDPOINT, data=request['body'].encode('utf-8'), method='POST',
        headers={'Content-Type':'application/x-www-form-urlencoded',
                 'User-Agent':'n8n-chatgpt-plan-bridge/0.1.0'})
    try:
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(req, timeout=22)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(1_048_577)
            if len(body) > 1_048_576:
                raise ValueError('Token response exceeded limit')
            result.update(status=response.status, body=body.decode('utf-8'))
            request_id = response.headers.get('x-request-id')
            if request_id and re.fullmatch(r'[A-Za-z0-9_-]{1,160}', request_id):
                result['request_id'] = request_id
    except (OSError, ValueError, urllib.error.URLError):
        result['transport_error'] = True
    return result

def process(sftp, name):
    path = DIRECTORY + '/' + name
    claimed = path.replace('.request.json', '.claimed.json')
    # An atomic claim prevents a second controller from replaying the one-time code.
    try:
        sftp.rename(path, claimed)
    except OSError:
        return
    with sftp.open(claimed, 'rb') as handle:
        raw = handle.read(32769)
    if len(raw) > 32768:
        raise ValueError('Exchange exceeded limit')
    request = json.loads(raw)
    validate(request, name)
    result = redeem(request)
    temporary = DIRECTORY + '/exchange-' + request['id'] + '.' + uuid.uuid4().hex + '.tmp'
    target = path.replace('.request.json', '.response.json')
    with sftp.open(temporary, 'wx') as handle:
        sftp.chmod(temporary, 0o600)
        handle.write(json.dumps(result))
    try:
        sftp.stat(claimed)  # A timed-out VM exchange must not receive late credentials.
    except OSError:
        sftp.remove(temporary)
        return
    sftp.rename(temporary, target)
    print('Local OAuth exchange returned HTTP ' + str(result['status']) + '.', flush=True)

def main():
    import paramiko
    client = paramiko.SSHClient()
    client.load_host_keys(str(Path.home() / '.ssh' / 'known_hosts'))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect('100.64.63.105', username='saad', password=os.environ['N8N_VM_PASSWORD'],
        look_for_keys=False, allow_agent=False, timeout=15)
    client.get_transport().set_keepalive(20)
    try:
        with client.open_sftp() as sftp:
            print('Local OAuth controller ready. Token exchange runs on this computer; refresh stays on the VM.', flush=True)
            while True:
                for name in sftp.listdir(DIRECTORY):
                    if FILE_PATTERN.fullmatch(name):
                        try:
                            process(sftp, name)
                        except (ValueError, OSError, json.JSONDecodeError):
                            print('An invalid or expired exchange was discarded. Start a fresh sign-in.', flush=True)
                time.sleep(0.2)
    finally:
        client.close()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
