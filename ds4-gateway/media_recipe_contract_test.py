import copy
import hashlib
import io
import json
import subprocess
import tarfile
import unittest
from types import SimpleNamespace

import media_recipe_contract as m


class RecipeContractTests(unittest.TestCase):
    def setUp(self):
        self.container='a'*64;self.image='sha256:'+'b'*64;self.calls=[];self.inspect_count=0
        self.native={'Id':self.container,'Image':self.image,'Config':{'WorkingDir':'/opt/ace-step'},
                     'HostConfig':{},'Mounts':[],'State':{'Running':False,'StartedAt':'original'}}
        self.files={'/opt/ace-step/'+name:('source:'+name).encode() for name in m.FILES}
        self.receipt={'schema':1,'state':'verified','checks':52,'supported':m.SUPPORTED,
                      'source_sha256':{name:hashlib.sha256(self.files['/opt/ace-step/'+name]).hexdigest() for name in m.FILES}}
        self.publish()
        self.drift=False;self.symlink=False

    def publish(self):self.files['/opt/stargate/recipe-fields-verification.json']=json.dumps(self.receipt).encode()

    def execute(self,args,**kwargs):
        self.calls.append(args);self.assertTrue(kwargs['check']);self.assertEqual(args[0],'docker')
        if args[1]=='inspect':
            self.inspect_count+=1;native=copy.deepcopy(self.native)
            if self.drift and self.inspect_count>1:native['State']['StartedAt']='external'
            return SimpleNamespace(stdout=json.dumps([native]).encode())
        self.assertEqual(args[1],'cp');self.assertEqual(args[-1],'-')
        cid,path=args[2].split(':',1);self.assertEqual(cid,self.container)
        if path not in self.files:raise subprocess.CalledProcessError(1,args)
        data=self.files[path];out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w') as archive:
            info=tarfile.TarInfo(path.rsplit('/',1)[1]);info.size=len(data)
            if self.symlink:info.type=tarfile.SYMTYPE;info.linkname='/private';info.size=0
            archive.addfile(info,io.BytesIO(data))
        return SimpleNamespace(stdout=out.getvalue())

    def read(self):return m.inspect_recipe(self.container,self.image,self.execute)

    def test_stopped_exact_engine_is_read_without_start_exec_or_file_mutation(self):
        before=copy.deepcopy(self.files);r=self.read()
        self.assertEqual(r['state'],'verified');self.assertEqual(r['supported'],m.SUPPORTED)
        self.assertEqual(r['source_sha256'],self.receipt['source_sha256']);self.assertEqual(before,self.files)
        self.assertTrue(all(c[1] in ('inspect','cp') for c in self.calls));self.assertEqual(self.inspect_count,2)

    def test_missing_build_receipt_never_implies_support(self):
        del self.files['/opt/stargate/recipe-fields-verification.json']
        with self.assertRaises(subprocess.CalledProcessError):self.read()

    def test_changed_source_and_incomplete_or_forged_schema_are_rejected(self):
        self.files['/opt/ace-step/'+m.FILES[0]]=b'changed'
        with self.assertRaises(ValueError):self.read()
        self.files['/opt/ace-step/'+m.FILES[0]]=('source:'+m.FILES[0]).encode()
        for change in ({'state':'candidate'},{'supported':{'sampler_mode':['heun']}},{'checks':0},{'source_sha256':{}}):
            saved=copy.deepcopy(self.receipt);self.receipt.update(change);self.publish()
            with self.assertRaises(ValueError):self.read()
            self.receipt=saved;self.publish()

    def test_changed_image_state_and_link_payloads_are_not_proof(self):
        self.native['Image']='sha256:'+'c'*64
        with self.assertRaises(ValueError):self.read()
        self.native['Image']=self.image;self.inspect_count=0;self.drift=True
        with self.assertRaises(ValueError):self.read()
        self.drift=False;self.symlink=True
        with self.assertRaises(ValueError):self.read()

    def test_non_exact_ids_refuse_before_any_docker_command(self):
        with self.assertRaises(ValueError):m.inspect_recipe('friendly-name',self.image,self.execute)
        self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
