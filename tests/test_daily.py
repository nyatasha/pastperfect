"""The Daily Challenge: identical for everyone, stable once written."""

import datetime as _dt
import unittest

from pastperfect import config, daily, db, pairs
from tests.fixtures import Sandbox


class DailySets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = Sandbox()
        cls.sandbox.__enter__()
        pairs.build(log=lambda *a: None)
        daily.ensure(days=20, start=daily.today(), log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.sandbox.__exit__(None, None, None)

    def test_today_has_a_full_set(self):
        rows = daily.questions(daily.today())
        self.assertEqual(len(rows), config.DAILY_QUESTIONS)

    def test_generation_is_deterministic_for_a_date(self):
        first = daily.build_day(_dt.date(2027, 3, 14))
        second = daily.build_day(_dt.date(2027, 3, 14))
        self.assertEqual(first, second)

    def test_different_days_differ(self):
        a = [row[3] for row in daily.build_day(_dt.date(2027, 3, 14))]
        b = [row[3] for row in daily.build_day(_dt.date(2027, 3, 15))]
        self.assertNotEqual(a, b)

    def test_no_object_repeats_inside_one_day(self):
        seen = set()
        for row in daily.questions(daily.today()):
            for object_id in (row["left_id"], row["right_id"]):
                self.assertNotIn(object_id, seen, "object used twice in one day")
                seen.add(object_id)

    def test_stored_sets_do_not_move_when_regenerated(self):
        before = [row["pair_id"] for row in daily.questions(daily.today())]
        daily.ensure(days=20, start=daily.today(), log=lambda *a: None)
        self.assertEqual(before, [row["pair_id"] for row in daily.questions(daily.today())])

    def test_difficulty_curve_is_broadly_followed(self):
        levels = [row["difficulty"] for row in daily.questions(daily.today())]
        self.assertLessEqual(sum(levels[:3]) / 3, sum(levels[-3:]) / 3)

    def test_museum_editions_only_use_their_own_collection(self):
        for slug in config.MUSEUM_ORDER:
            rows = daily.questions(daily.today(), slug)
            if not rows:
                continue  # the fixture is small; an edition may not fill
            for row in rows:
                self.assertEqual(row["museums"], slug)

    def test_puzzle_numbering(self):
        self.assertEqual(daily.puzzle_number(config.EPOCH_DATE), 1)
        self.assertEqual(daily.puzzle_number(config.EPOCH_DATE + _dt.timedelta(days=9)), 10)

    def test_past_puzzles_are_closed_by_default(self):
        self.assertTrue(daily.playable_day(daily.today()))
        self.assertFalse(daily.playable_day(daily.today() - _dt.timedelta(days=1)))
        self.assertFalse(daily.playable_day(daily.today() + _dt.timedelta(days=1)))

    def test_cooldown_keeps_consecutive_days_fresh(self):
        """Recent objects are avoided while the pool can afford it.

        Freshness is a preference rather than a guarantee: a thin pool should
        soften the rule, not leave a hole in somebody's puzzle.
        """
        today = daily.today()
        days = []
        for offset in range(3):
            rows = daily.questions(today + _dt.timedelta(days=offset))
            days.append({row["left_id"] for row in rows} | {row["right_id"] for row in rows})
        self.assertEqual(days[0] & days[1], set())
        self.assertEqual(days[0] & days[2], set())

    def test_date_parsing_rejects_rubbish(self):
        self.assertIsNone(daily.parse_date("not-a-date"))
        self.assertIsNone(daily.parse_date("2026-13-45"))
        self.assertEqual(daily.parse_date("2026-09-04"), _dt.date(2026, 9, 4))


if __name__ == "__main__":
    unittest.main()
