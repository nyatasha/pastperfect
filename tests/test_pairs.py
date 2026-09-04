"""The pair pool. A question exists only when its answer is provable."""

import unittest

from pastperfect import config, db, insights, pairs
from tests.fixtures import Sandbox


class PairBuilding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = Sandbox()
        cls.sandbox.__enter__()
        pairs.build(log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.sandbox.__exit__(None, None, None)

    def rows(self):
        return list(db.connect().execute(
            "SELECT p.*, l.year_start AS ls, l.year_end AS le, r.year_start AS rs, "
            "r.year_end AS re, l.museum AS lm, r.museum AS rm "
            "FROM pairs p JOIN objects l ON l.id = p.left_id JOIN objects r ON r.id = p.right_id"
        ))

    def test_pool_is_not_empty(self):
        self.assertGreater(len(self.rows()), 20)

    def test_no_pair_has_overlapping_ranges(self):
        for row in self.rows():
            disjoint = row["le"] < row["rs"] or row["re"] < row["ls"]
            self.assertTrue(disjoint, f"{row['left_id']} vs {row['right_id']} overlap")

    def test_recorded_answer_matches_the_dates(self):
        for row in self.rows():
            if row["earlier"] == "left":
                self.assertLess(row["le"], row["rs"], row["id"])
            else:
                self.assertLess(row["re"], row["ls"], row["id"])

    def test_guaranteed_gap_is_the_provable_minimum(self):
        for row in self.rows():
            expected = (row["rs"] - row["le"]) if row["earlier"] == "left" else (row["ls"] - row["re"])
            self.assertEqual(row["guaranteed_gap"], expected, row["id"])
            self.assertGreaterEqual(row["guaranteed_gap"], config.MIN_PAIR_GAP_YEARS)

    def test_every_pair_carries_an_insight(self):
        for row in self.rows():
            self.assertTrue(row["insight"].strip(), row["id"])
            self.assertLess(len(row["insight"]), 200, row["id"])

    def test_difficulty_is_in_range_and_museums_recorded(self):
        for row in self.rows():
            self.assertIn(row["difficulty"], (1, 2, 3, 4, 5))
            self.assertEqual(row["museums"], "|".join(sorted({row["lm"], row["rm"]})))

    def test_rebuilding_is_idempotent(self):
        before = {r["id"] for r in self.rows()}
        pairs.build(log=lambda *a: None)
        self.assertEqual(before, {r["id"] for r in self.rows()})


class Difficulty(unittest.TestCase):
    def make(self, **kwargs):
        base = {"region": "Europe", "looks_modern": 0}
        return {**base, **kwargs}

    def test_wide_gaps_are_easy_and_narrow_gaps_are_hard(self):
        easy, _ = pairs.difficulty_for(self.make(), self.make(), 900)
        hard, _ = pairs.difficulty_for(self.make(), self.make(), 4)
        self.assertLess(easy, hard)

    def test_a_misleading_visual_cue_is_flagged_and_costs_a_level(self):
        plain, plain_surprise = pairs.difficulty_for(self.make(), self.make(), 120)
        tricky, surprise = pairs.difficulty_for(
            self.make(looks_modern=1), self.make(), 120
        )
        self.assertTrue(surprise)
        self.assertFalse(plain_surprise)
        self.assertGreater(tricky, plain)

    def test_a_helpful_visual_cue_makes_it_easier(self):
        plain, _ = pairs.difficulty_for(self.make(), self.make(), 120)
        helped, surprise = pairs.difficulty_for(self.make(), self.make(looks_modern=1), 120)
        self.assertFalse(surprise)
        self.assertLess(helped, plain)

    def test_crossing_regions_is_harder(self):
        same, _ = pairs.difficulty_for(self.make(), self.make(), 120)
        crossed, _ = pairs.difficulty_for(self.make(), self.make(region="East Asia"), 120)
        self.assertGreater(crossed, same)

    def test_unknown_region_is_not_treated_as_a_difference(self):
        same, _ = pairs.difficulty_for(self.make(), self.make(), 120)
        unknown, _ = pairs.difficulty_for(self.make(region="Unknown"), self.make(), 120)
        self.assertEqual(same, unknown)


class NearDuplicates(unittest.TestCase):
    def test_plates_from_one_series_are_rejected(self):
        a = {"artist": "Goya", "title": "Los Caprichos, Plate 1"}
        b = {"artist": "Goya", "title": "Los Caprichos, Plate 2"}
        self.assertTrue(pairs._too_similar(a, b))

    def test_different_works_by_one_artist_are_kept(self):
        a = {"artist": "Goya", "title": "The Third of May"}
        b = {"artist": "Goya", "title": "Saturn Devouring His Son"}
        self.assertFalse(pairs._too_similar(a, b))

    def test_same_title_different_artists_is_kept(self):
        a = {"artist": "Monet", "title": "Self-Portrait"}
        b = {"artist": "Cezanne", "title": "Self-Portrait"}
        self.assertFalse(pairs._too_similar(a, b))


class Insights(unittest.TestCase):
    def obj(self, **kwargs):
        base = {
            "title": "A thing", "artist": None, "year_mid": 1700, "medium": "Oil on canvas",
            "classification": "Painting", "region": "Europe", "looks_modern": 0,
        }
        return {**base, **kwargs}

    def test_the_surprising_case_leads(self):
        line = insights.for_pair(
            self.obj(looks_modern=1, medium="Albumen silver print", classification="Photograph"),
            self.obj(year_mid=1900), 150, True,
        )
        self.assertIn("older", line)
        self.assertIn("photograph", line)

    def test_identical_forms_read_naturally(self):
        line = insights.for_pair(self.obj(), self.obj(year_mid=1702), 2, False)
        self.assertIn("two paintings", line)
        self.assertNotIn("a painting and a painting", line)

    def test_shared_maker_is_mentioned(self):
        line = insights.for_pair(
            self.obj(artist="Rembrandt van Rijn (Dutch)"),
            self.obj(artist="Rembrandt van Rijn (Dutch)", year_mid=1660), 40, False,
        )
        self.assertIn("Rembrandt", line)

    def test_never_empty_for_any_shape_of_record(self):
        line = insights.for_pair(
            self.obj(region="Unknown", medium=None, classification=None),
            self.obj(region="Unknown", medium=None, classification=None, year_mid=1850),
            150, True,
        )
        self.assertTrue(line.strip())


if __name__ == "__main__":
    unittest.main()
