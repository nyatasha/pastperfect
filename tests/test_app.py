"""End-to-end checks against the WSGI application.

The most important test in the file is test_round_payload_reveals_nothing: if a
question payload ever starts carrying dates or titles, the game is broken even
though everything still renders.
"""

import io
import json
import re
import unittest

from pastperfect import config, daily, pairs
from pastperfect.app import application
from tests.fixtures import Sandbox


def call(method: str, path: str, body: dict | None = None):
    payload = json.dumps(body).encode() if body is not None else b""
    query = ""
    if "?" in path:
        path, query = path.split("?", 1)
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(payload),
    }
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    chunks = application(environ, start_response)
    return captured["status"], captured["headers"], b"".join(chunks)


class Pages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = Sandbox()
        cls.sandbox.__enter__()
        pairs.build(log=lambda *a: None)
        daily.ensure(days=5, start=daily.today(), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.sandbox.__exit__(None, None, None)

    def test_every_public_page_renders(self):
        paths = ["/", "/daily", "/endless", "/museums", "/how-to-play", "/about",
                 "/rights", "/stats", "/robots.txt", "/sitemap.xml",
                 "/manifest.webmanifest", "/sw.js"]
        paths += [f"/museum/{slug}" for slug in config.MUSEUM_ORDER]
        paths += [f"/daily/{slug}" for slug in config.MUSEUM_ORDER]
        paths += [f"/endless/{slug}" for slug in config.MUSEUM_ORDER]
        for path in paths:
            status, _, body = call("GET", path)
            self.assertEqual(status, "200 OK", path)
            floor = 80 if path.endswith(".txt") else 500
            self.assertGreater(len(body), floor, path)

    def test_pages_carry_seo_metadata(self):
        for path in ["/", "/daily", "/museum/met", "/about"]:
            _, _, body = call("GET", path)
            html = body.decode()
            self.assertIn('<meta name="description"', html)
            self.assertIn('rel="canonical"', html)
            self.assertIn('property="og:image"', html)
            self.assertIn("<title>", html)

    def test_structured_data_is_valid_json(self):
        _, _, body = call("GET", "/")
        blocks = re.findall(
            r'<script type="application/ld\+json">(.*?)</script>', body.decode(), re.S
        )
        self.assertGreaterEqual(len(blocks), 2)
        for block in blocks:
            self.assertIn("@context", json.loads(block))

    def test_unknown_paths_and_museums_are_404(self):
        for path in ["/nope", "/museum/louvre", "/endless/louvre", "/daily/louvre"]:
            status, _, _ = call("GET", path)
            self.assertEqual(status, "404 Not Found", path)

    def test_past_puzzles_are_closed(self):
        status, _, body = call("GET", "/daily/2020-01-01")
        self.assertEqual(status, "410 Gone")
        self.assertIn("closed", body.decode().lower())

    def test_trailing_slash_redirects(self):
        status, headers, _ = call("GET", "/about/")
        self.assertEqual(status, "301 Moved Permanently")
        self.assertEqual(headers["Location"], "/about")

    def test_static_files_cannot_escape_their_directory(self):
        status, _, _ = call("GET", "/static/../../pastperfect/config.py")
        self.assertNotEqual(status, "200 OK")

    def test_no_advertising_is_rendered(self):
        self.assertFalse(config.ADS_ENABLED)
        for path in ["/", "/daily", "/endless"]:
            _, _, body = call("GET", path)
            self.assertNotIn('class="ad-slot"', body.decode(), path)

    def test_security_headers_are_set(self):
        _, headers, _ = call("GET", "/")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("Referrer-Policy", headers)


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = Sandbox()
        cls.sandbox.__enter__()
        pairs.build(log=lambda *a: None)
        daily.ensure(days=5, start=daily.today(), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.sandbox.__exit__(None, None, None)

    def round(self, query="mode=daily"):
        status, _, body = call("GET", f"/api/round?{query}")
        self.assertEqual(status, "200 OK")
        return json.loads(body)

    def test_daily_round_is_the_right_shape(self):
        data = self.round()
        self.assertEqual(data["total"], config.DAILY_QUESTIONS)
        self.assertEqual(data["date"], daily.today().isoformat())
        for question in data["questions"]:
            self.assertEqual(sorted(question), ["a", "b", "id", "n"])
            for side in ("a", "b"):
                self.assertEqual(sorted(question[side]), ["h", "img", "w"])
                self.assertRegex(question[side]["img"], r"^/img/[0-9a-f]{20}\.jpg$")

    def test_round_payload_reveals_nothing(self):
        """No title, maker, date, museum or answer may appear before a guess."""
        raw = json.dumps(self.round()["questions"])
        for word in ("title", "artist", "year", "museum", "credit", "licen",
                     "insight", "earlier", "medium", "gap", "difficulty"):
            self.assertNotIn(word, raw.lower(), f"{word!r} leaked into the question payload")
        # Nothing that could be read as a date, either.
        self.assertEqual(re.findall(r"(?<!\d)(1[0-9]{3})(?!\d)", raw.replace("1100", "")), [])

    def test_answering_reveals_everything_and_is_correct(self):
        data = self.round()
        for question in data["questions"]:
            status, _, body = call("POST", "/api/answer", {
                "q": question["id"], "choice": "a", "session": "unittestsession"
            })
            self.assertEqual(status, "200 OK")
            reveal = json.loads(body)
            self.assertIn(reveal["earlier"], ("a", "b"))
            self.assertEqual(reveal["correct"], reveal["earlier"] == "a")
            self.assertTrue(reveal["insight"])
            for side in ("a", "b"):
                for field in ("title", "date", "yearText", "museumName", "licence", "objectUrl"):
                    self.assertIn(field, reveal[side])
            earlier, later = ((reveal["a"], reveal["b"]) if reveal["earlier"] == "a"
                              else (reveal["b"], reveal["a"]))
            self.assertLess(earlier["year"], later["year"])

    def test_a_repeated_answer_is_only_counted_once(self):
        question = self.round()["questions"][0]
        for _ in range(3):
            call("POST", "/api/answer",
                 {"q": question["id"], "choice": "b", "session": "repeatsession"})
        from pastperfect import db
        row = db.connect().execute(
            "SELECT shown FROM pair_stats WHERE pair_id = ?", (question["id"].split(".")[0],)
        ).fetchone()
        self.assertEqual(row["shown"], 1)

    def test_malformed_answers_are_rejected(self):
        for payload in [{}, {"q": "nope", "choice": "a"},
                        {"q": "0" * 16 + ".0", "choice": "c"},
                        {"q": "../../etc/passwd", "choice": "a"}]:
            status, _, _ = call("POST", "/api/answer", payload)
            self.assertIn(status.split()[0], ("400", "404"), payload)

    def test_endless_never_repeats_a_question(self):
        seen = set()
        for page in range(4):
            data = self.round(f"mode=endless&seed=endlessseed&page={page}")
            ids = [q["id"].split(".")[0] for q in data["questions"]]
            self.assertTrue(set(ids).isdisjoint(seen), f"page {page} repeated a question")
            seen.update(ids)
        self.assertGreater(len(seen), 8)

    def test_endless_is_stable_for_a_seed(self):
        first = [q["id"] for q in self.round("mode=endless&seed=stableseed&page=1")["questions"]]
        again = [q["id"] for q in self.round("mode=endless&seed=stableseed&page=1")["questions"]]
        self.assertEqual(first, again)

    def test_completing_a_daily_records_a_standing(self):
        status, _, body = call("POST", "/api/daily/complete", {
            "date": daily.today().isoformat(), "edition": "", "score": 7,
            "session": "completesession",
        })
        self.assertEqual(status, "200 OK")
        result = json.loads(body)
        self.assertEqual(result["score"], 7)
        self.assertGreaterEqual(result["players"], 1)
        self.assertIsNone(result["percentile"], "percentile shown before it means anything")

    def test_impossible_scores_are_rejected(self):
        for score in (-1, 11, "many", None):
            status, _, _ = call("POST", "/api/daily/complete", {
                "date": daily.today().isoformat(), "edition": "", "score": score,
                "session": "badsession",
            })
            self.assertEqual(status, "400 Bad Request", score)

    def test_events_are_accepted_and_stored(self):
        status, _, _ = call("POST", "/api/events", {
            "name": "unit_test_event", "session": "eventsession", "props": {"a": 1}
        })
        self.assertEqual(status, "204 No Content")
        from pastperfect import store
        self.assertIn("unit_test_event", [row["name"] for row in store.event_summary()])

    def test_health(self):
        status, _, body = call("GET", "/api/health")
        self.assertEqual(status, "200 OK")
        health = json.loads(body)
        self.assertTrue(health["ok"])
        self.assertFalse(health["adsEnabled"])


if __name__ == "__main__":
    unittest.main()
