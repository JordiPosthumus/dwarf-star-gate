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
        register_research({"search_url": "http://example.invalid", "extract_url": "http://example.invalid"}, {"servers": [{"id": "private-worker"}]}, lambda _, **kw: self.events.append(kw["event"]))

    def test_private_query_details_never_reach_search(self):
        synthetic_home = str(PurePosixPath("/", "Users", "example", "settings"))
        for query in ["private-worker runtime", "read " + synthetic_home, "api_key=PRIVATE_VALUE", "password=PRIVATE_VALUE", "", 3]:
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


if __name__ == "__main__":
    unittest.main()
