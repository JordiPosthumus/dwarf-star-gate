import sys
import types
import unittest
from pathlib import PurePosixPath
from urllib.parse import urlunsplit
from unittest.mock import patch, Mock
from genie_research import register_research


class ResearchValidation(unittest.TestCase):
    def setUp(self):
        self.handlers = {}
        self.network = Mock(side_effect=AssertionError("Network must not be called"))
        registry = types.SimpleNamespace(register=lambda **kw: self.handlers.update({kw["name"]: kw["handler"]}))
        self.modules = patch.dict(sys.modules, {
            "httpx": types.SimpleNamespace(Client=self.network),
            "tools.registry": types.SimpleNamespace(registry=registry),
            "tools.url_safety": types.SimpleNamespace(is_safe_url=lambda url: False, sensitive_query_param_name=lambda url: None, create_ssrf_safe_client=self.network),
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.events = []
        register_research({"search_url": "http://example.invalid", "extract_url": "http://example.invalid"}, {"servers": [{"id": "private-worker"}], "operational_activity": {"reviews": [{"worker": "retired-worker", "id": "private-review-id"}], "actions": [{"source": "old-source", "destination": "old-destination"}]}}, lambda _, **kw: self.events.append(kw["event"]))

    def test_private_query_details_never_reach_search(self):
        synthetic_home = str(PurePosixPath("/", "Users", "example", "settings"))
        for query in ["private-worker runtime", "retired-worker runtime", "private-review-id", "old-source", "old-destination", "read " + synthetic_home, "api_key=PRIVATE_VALUE", "password=PRIVATE_VALUE", "", 3]:
            with self.subTest(query=query):
                result = self.handlers["web_search"]({"query": query})
                self.assertIn('"error"', result)
                self.assertNotIn("PRIVATE_VALUE", result)
        self.network.assert_not_called()

    def test_private_and_non_web_urls_never_reach_extraction(self):
        synthetic_credentials = urlunsplit(("https", "user:pass@example.org", "/", "", ""))
        for url in ["file:///etc/passwd", "http://127.0.0.1/status", synthetic_credentials, "https://127.0.0.1/status"]:
            with self.subTest(url=url):
                self.assertIn('"error"', self.handlers["web_extract"]({"url": url}))
        self.network.assert_not_called()

    def test_failed_services_do_not_reveal_error_bodies_or_fall_back(self):
        self.network.side_effect = RuntimeError("PRIVATE_RESPONSE_OR_CREDENTIAL")
        result = self.handlers["web_search"]({"query": "example software release"})
        self.assertNotIn("PRIVATE_RESPONSE_OR_CREDENTIAL", result)
        self.assertIn("No alternate provider", result)
        self.assertEqual(self.network.call_count, 1)
        self.assertEqual(self.events[-1]["state"], "failed")

    def test_hourglass_run_and_private_association_identifiers_stay_out_of_search(self):
        identifiers = ['private-report', 'benchmark-worker', 'private-approval', 'private-run', 'private-config', 'private-machine', 'private-bank']
        row = {'report_revision': identifiers[0], 'association': {'worker_id': identifiers[1], 'approved_configuration_revision': identifiers[2]},
               'summary': dict(zip(('run_key', 'configuration_key', 'machine_key', 'bank_fingerprint'), identifiers[3:]))}
        register_research({'search_url': 'http://example.invalid', 'extract_url': 'http://example.invalid'},
                          {'hourglass_reports': {'reports': [row]}, 'hourglass_measurements': {'runs': [{'id': 'private-measurement', 'worker_id': 'measurement-worker'}]}}, lambda _, **kw: self.events.append(kw['event']))
        for value in identifiers + ['private-measurement', 'measurement-worker']:
            self.assertIn('"error"', self.handlers['web_search']({'query': 'compare ' + value}))
        self.network.assert_not_called()

    def test_notebook_reference_identifiers_are_withheld_from_public_tools(self):
        identifiers = ['private-note', 'private-note-digest', 'former-worker', 'private-operation', 'private-request', 'private-candidate', 'private-transition']
        note = {'id': identifiers[0], 'source_digest': identifiers[1],
                'data': dict(zip(('worker', 'operation_id', 'request_id', 'candidate_id'), identifiers[2:6])),
                'recent_transitions': [{'source_digest': identifiers[6]}]}
        register_research({'search_url': 'http://example.invalid', 'extract_url': 'http://example.invalid'},
                          {'operational_notebook': {'notes': [note]}}, lambda _, **kw: self.events.append(kw['event']))
        for value in identifiers:
            self.assertIn('"error"', self.handlers['web_search']({'query': 'research ' + value}))
            self.assertIn('"error"', self.handlers['web_extract']({'url': 'https://example.invalid/' + value}))
        self.network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
