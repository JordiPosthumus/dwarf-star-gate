"""Private read-only preparation entry used by the dashboard."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hourglass_prepare import prepare

if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        result = prepare(request['proposal'], request['enrollment'], request['prepared'],
            request['directory'], request['record_revision'])
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'The worker and exact measurement could not be prepared. No benchmark or server change was started.'}))
        sys.exit(1)
