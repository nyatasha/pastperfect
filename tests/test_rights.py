"""The rights gate decides what we are allowed to show at all."""

import unittest

from pastperfect import config, rights


class Normalise(unittest.TestCase):
    def test_identifiers_and_urls(self):
        cases = {
            "cc0": "cc0",
            "CC0": "cc0",
            "https://creativecommons.org/publicdomain/zero/1.0/": "cc0",
            "pdm": "pdm",
            "Public Domain Mark": "pdm",
            "https://creativecommons.org/publicdomain/mark/1.0/": "pdm",
            "cc-by": "cc-by",
            "https://creativecommons.org/licenses/by/4.0/": "cc-by",
        }
        for raw, expected in cases.items():
            self.assertEqual(rights.normalise(raw), expected, raw)

    def test_unknown_is_none(self):
        for raw in (None, "", "all rights reserved", "ask us nicely"):
            self.assertIsNone(rights.normalise(raw), raw)


class Gate(unittest.TestCase):
    def test_open_licences_pass_with_details(self):
        allowed, reason, detail = rights.evaluate("cc0", "test basis")
        self.assertTrue(allowed)
        self.assertEqual(reason, "")
        self.assertEqual(detail["license_id"], "cc0")
        self.assertEqual(detail["rights_basis"], "test basis")
        self.assertIn(detail["license_id"], config.ALLOWED_LICENCES)

    def test_noncommercial_and_noderivatives_refused(self):
        for raw in ("cc-by-nc", "cc-by-nc-sa", "cc-by-nd",
                    "https://creativecommons.org/licenses/by-nc-nd/4.0/"):
            allowed, reason, _ = rights.evaluate(raw, "test")
            self.assertFalse(allowed, raw)
            self.assertIn("excluded", reason)

    def test_in_copyright_refused(self):
        allowed, reason, _ = rights.evaluate("inc", "test")
        self.assertFalse(allowed)

    def test_absent_or_unrecognised_is_refused_not_assumed(self):
        for raw in (None, "", "something new"):
            allowed, reason, _ = rights.evaluate(raw, "test")
            self.assertFalse(allowed, raw)
            self.assertIn("no recognised licence", reason)

    def test_every_allowed_licence_round_trips(self):
        for key in config.ALLOWED_LICENCES:
            allowed, _, detail = rights.evaluate(key, "test")
            self.assertTrue(allowed, key)
            self.assertTrue(detail["license_url"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()
