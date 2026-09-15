"""Private dashboard preparation transport; one read-only preparation per process."""
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from operation_maintenance import GatewayControl
from serving_prepare import prepare

if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        enrollment = request['enrollment']
        gateway = GatewayControl(enrollment['gateway_socket'])('/workers')
        if gateway.get('conditional_resume_version') != 1:
            raise ValueError('Conditional readmission support is not deployed')
        if not any(w.get('id') == enrollment['worker_id'] for w in gateway.get('workers',[])):
            raise ValueError('The enrolled worker is absent from the gateway')
        print(json.dumps(prepare(request['proposal'],enrollment,request['directory'],request['record_revision'])))
    except Exception:
        # Native/SSH/Git exceptions can contain private values. The retained
        # proposal is still available; this process never launched a change.
        print(json.dumps({'error':'Preparation could not establish the enrolled gateway, approved record, restoration proof and exact recipe. No server changes were made.'}))
        sys.exit(1)
