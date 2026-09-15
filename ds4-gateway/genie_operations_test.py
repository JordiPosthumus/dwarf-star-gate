import json
from http.server import BaseHTTPRequestHandler,HTTPServer
import threading
import types
import sys
import unittest
from unittest.mock import patch

from genie_operations import register_operations,NAMES


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.calls,self.events,self.catalog=[],[],{}
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append((self.path,self.headers.get('X-SG-Operation-Tool'),body))
                if getattr(owner,'redirect',False):
                    self.send_response(302);self.send_header('Location','/must-not-follow');self.end_headers();return
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'id':body.get('proposal',{}).get('id'),'state':'preparing'}).encode())
            def log_message(self,*args):pass
        server=HTTPServer(('127.0.0.1',0),Handler);self.server=server
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        registry=types.SimpleNamespace(register=lambda **kw:self.catalog.update({kw['name']:kw}))
        module=types.ModuleType('tools.registry');module.registry=registry
        self.patch=patch.dict(sys.modules,{'tools.registry':module});self.patch.start();self.addCleanup(self.patch.stop)
        self.config={'url':f'http://127.0.0.1:{server.server_port}/api/genie/operation-tools','token':'fixture-token','workers':['fixture'],
            'origin':{'conversation_id':'fixture-conversation','reply_id':'fixture-reply'}}
        self.emit=lambda kind,**kw:self.events.append((kind,kw))
        register_operations(self.config,self.emit)

    def test_catalog_only_offers_proposal_and_status_and_records_actual_tool_result(self):
        self.assertEqual(set(self.catalog),NAMES)
        proposal={'id':'fixture-id','worker_id':'fixture','image':'sha256:'+'a'*64,'command':['fixture'],'reason':'Fixture only'}
        result=json.loads(self.catalog['propose_server_change']['handler'](proposal))
        path,token,body=self.calls[0]
        self.assertEqual(path,'/api/genie/operation-tools');self.assertEqual(token,'fixture-token')
        self.assertEqual(body,{'action':'propose','proposal':proposal,'origin':self.config['origin']})
        self.assertEqual(result['state'],'preparing')
        self.assertEqual([e[1]['event']['state'] for e in self.events],['reading','complete'])
        self.assertNotIn('fixture-token',json.dumps(self.events));self.assertNotIn('approve',self.catalog)
        self.assertEqual(self.events[0][1]['event']['request'],proposal)

    def test_attempt_arguments_are_kept_with_existing_credential_scrubbing(self):
        proposal={'id':'fixture-id','command':['serve','--api-key','PRIVATE_SECRET','--max-num-seqs','2']}
        self.catalog['propose_server_change']['handler'](proposal)
        recorded=self.events[0][1]['event']['request']
        self.assertNotIn('PRIVATE_SECRET',json.dumps(recorded))
        self.assertEqual(recorded['command'][-2:],['--max-num-seqs','2'])
        self.assertEqual(self.calls[0][2]['proposal'],proposal)

    def test_redirect_is_not_followed_and_uncertain_proposal_is_not_repeated(self):
        self.redirect=True
        result=json.loads(self.catalog['propose_server_change']['handler']({'id':'same-attempt'}))
        self.assertIn('same operation ID',result['error']);self.assertEqual(len(self.calls),1)
        self.assertEqual(self.events[-1][1]['event']['state'],'failed')

    def test_arbitrary_endpoint_cannot_be_enrolled_in_the_tool(self):
        with self.assertRaises(ValueError):register_operations({**self.config,'url':'https://example.invalid/'},self.emit)


if __name__=='__main__':unittest.main()
