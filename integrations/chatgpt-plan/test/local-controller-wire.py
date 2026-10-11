"""Exercise the desktop grant transport with a single-use mock token endpoint."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode
spec = importlib.util.spec_from_file_location('controller', Path(__file__).parents[1] / 'tools/local-oauth-controller.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)

class WireTest(unittest.TestCase):
    def test_pkce_form_identity_error_and_no_redirect_replay(self):
        verifier = 'a' * 86
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        counts = {'code':0,'redirect_target':0}
        class TokenHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                if self.path == '/redirect':
                    self.send_response(307); self.send_header('Location','/redirect-target'); self.end_headers(); return
                if self.path == '/redirect-target':
                    counts['redirect_target'] += 1
                counts['code'] += 1
                fields = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode(), strict_parsing=True)
                valid = fields == expected and base64.urlsafe_b64encode(hashlib.sha256(fields['code_verifier'][0].encode()).digest()).rstrip(b'=').decode() == challenge
                status = 200 if valid and counts['code'] == 1 else 400
                self.send_response(status); self.send_header('x-request-id','request_fixture'); self.end_headers()
                self.wfile.write(json.dumps({'access_token':'fake-only'} if status == 200 else {'error':'invalid_grant'}).encode())
        fields = {'grant_type':'authorization_code','client_id':'oaiapp_fixture','code':'one+use/=code','code_verifier':verifier,'redirect_uri':controller.CALLBACK,'resource':'https://api.openai.com/v1'}
        expected = {k:[v] for k,v in fields.items()}
        now = int(time.time()*1000)
        identifier = '12345678-1234-1234-1234-123456789012'
        request = {'version':1,'id':identifier,'created_at':now,'expires_at':now+30000,'endpoint':controller.ENDPOINT,'body':urlencode(fields)}
        controller.validate(request, 'exchange-'+identifier+'.request.json')
        server = HTTPServer(('127.0.0.1',0), TokenHandler)
        thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        endpoint = controller.ENDPOINT
        try:
            controller.ENDPOINT = 'http://127.0.0.1:'+str(server.server_port)+'/token'
            result = controller.redeem(request)
            self.assertEqual(result['status'],200); self.assertEqual(result['request_id'],'request_fixture')
            self.assertEqual(counts['code'],1)
            rejected = controller.redeem(request)
            self.assertEqual(rejected['status'],400); self.assertEqual(json.loads(rejected['body']),{'error':'invalid_grant'})
            controller.ENDPOINT = 'http://127.0.0.1:'+str(server.server_port)+'/redirect'
            redirected = controller.redeem(request)
            self.assertEqual(redirected['status'],307); self.assertEqual(counts['redirect_target'],0)
        finally:
            controller.ENDPOINT = endpoint
            server.shutdown(); server.server_close(); thread.join()
if __name__ == '__main__':
    unittest.main()
