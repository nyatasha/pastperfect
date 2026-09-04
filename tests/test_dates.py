"""The date parser is the correctness core, so it gets the most tests."""

import unittest

from pastperfect import config
from pastperfect.dates import (DateEstimate, century_key, century_label,
                               describe_gap, estimate, format_year, parse_display)


class ParseDisplay(unittest.TestCase):
    def assertRange(self, text, start, end, precision=None):
        result = parse_display(text)
        self.assertIsNotNone(result, f"{text!r} did not parse")
        self.assertEqual((result.start, result.end), (start, end), text)
        if precision:
            self.assertEqual(result.precision, precision, text)

    def test_plain_years(self):
        self.assertRange("1878", 1878, 1878, "year")
        self.assertRange("[1877]", 1877, 1877)
        self.assertRange("Bruxelles : Mayolez, 1877.", 1877, 1877)

    def test_ranges(self):
        self.assertRange("1798-1802", 1798, 1802, "range")
        self.assertRange("1884-86", 1884, 1886)
        self.assertRange("1630/36", 1630, 1636)      # the Art Institute's house style
        self.assertRange("1893/1894", 1893, 1894)
        self.assertRange("between 1900 and 1910", 1900, 1910)

    def test_day_month_year_notation_is_not_a_range(self):
        self.assertIsNone(parse_display("Anarchiste. 14/3/94."))

    def test_circa_widens(self):
        self.assertRange("ca. 1470", 1465, 1475, "circa")
        self.assertRange("probably 1512", 1507, 1517, "circa")
        self.assertRange("1642 (?)", 1637, 1647, "circa")

    def test_centuries(self):
        self.assertRange("17th century", 1600, 1699, "century")
        self.assertRange("late 17th century", 1667, 1699)
        self.assertRange("mid-18th century", 1733, 1766)
        self.assertRange("second half of the 19th century", 1850, 1899)
        self.assertRange("19th-20th century", 1800, 1999)
        self.assertRange("17th and 18th centuries", 1600, 1799)

    def test_decades_and_shorthand(self):
        self.assertRange("1890s", 1890, 1899, "decade")
        self.assertRange("1500s", 1500, 1599, "century")  # ambiguous -> wider reading
        self.assertRange("18--", 1800, 1899)
        self.assertRange("185-", 1850, 1859)

    def test_before_and_after(self):
        self.assertRange("before 1600", 1575, 1600)
        self.assertRange("after 1850", 1850, 1875)

    def test_bce(self):
        self.assertRange("500 B.C.", -500, -500)
        self.assertRange("500-400 B.C.", -500, -400)
        self.assertRange("1st century B.C.", -100, -1)
        self.assertRange("late 1st century B.C.", -33, -1)

    def test_unusable(self):
        for text in ("n.d.", "undated", "date unknown", "plate 4", "", "   "):
            self.assertIsNone(parse_display(text), text)

    def test_period_parenthetical_is_context_not_a_date(self):
        self.assertIsNone(parse_display("Edo period (1615-1868)"))
        self.assertRange("Ming dynasty (1368-1644), 15th century", 1400, 1499)

    def test_short_numbers_are_not_years(self):
        self.assertRange("Vol. 3, 1899", 1899, 1899)


class RepresentativeYear(unittest.TestCase):
    """The year printed on screen should be the museum's own claim."""

    def test_a_stated_year_inside_the_range_wins_over_the_midpoint(self):
        from pastperfect.dates import DateEstimate, representative_year
        estimate = DateEstimate(1854, 1858, "range", "1854")
        self.assertEqual(representative_year(estimate), 1854)

    def test_midpoint_is_used_when_the_label_names_no_single_year(self):
        from pastperfect.dates import DateEstimate, representative_year
        self.assertEqual(representative_year(DateEstimate(1600, 1699, "century", "17th century")), 1649)

    def test_a_stated_year_outside_the_range_is_ignored(self):
        from pastperfect.dates import DateEstimate, representative_year
        estimate = DateEstimate(1700, 1720, "range", "1650")
        self.assertEqual(representative_year(estimate), 1710)


class Reconcile(unittest.TestCase):
    def test_label_vagueness_widens_confident_fields(self):
        result = estimate("19th century", 1850, 1850)
        self.assertEqual((result.start, result.end), (1800, 1899))

    def test_numeric_context_does_not_widen(self):
        result = estimate("1884-86, border added 1888-89", 1884, 1886)
        self.assertEqual((result.start, result.end), (1884, 1889))
        result = estimate("Edo period (1615-1868)", 1700, 1750)
        self.assertEqual((result.start, result.end), (1700, 1750))

    def test_missing_sides(self):
        self.assertEqual(estimate(None, 1642, 1642).start, 1642)
        self.assertEqual(estimate("1642", None, None).start, 1642)
        self.assertIsNone(estimate("n.d.", None, None))

    def test_reversed_fields_are_repaired(self):
        result = estimate(None, 1700, 1600)
        self.assertEqual((result.start, result.end), (1600, 1700))


class Playability(unittest.TestCase):
    def test_wide_ranges_are_not_playable(self):
        wide = DateEstimate(1000, 1000 + config.MAX_OBJECT_SPAN_YEARS + 1, "range", "")
        self.assertFalse(wide.playable())
        edge = DateEstimate(1000, 1000 + config.MAX_OBJECT_SPAN_YEARS, "range", "")
        self.assertTrue(edge.playable())

    def test_out_of_bounds(self):
        self.assertFalse(DateEstimate(-99999, -99998, "range", "").playable())
        self.assertFalse(DateEstimate(config.MAX_YEAR + 5, config.MAX_YEAR + 6, "range", "").playable())


class Presentation(unittest.TestCase):
    def test_format_year(self):
        self.assertEqual(format_year(1642), "1642")
        self.assertEqual(format_year(-500), "500 BC")

    def test_century_helpers(self):
        self.assertEqual(century_label(1878), "19th century")
        self.assertEqual(century_label(-500), "5th century BC")
        self.assertEqual(century_key(1878), 18)
        self.assertEqual(century_key(-500), -5)

    def test_gap_wording_hedges_when_imprecise(self):
        self.assertIn("about", describe_gap(120, True))
        self.assertNotIn("about", describe_gap(12, False))
        self.assertEqual(describe_gap(1, False), "1 year apart")


if __name__ == "__main__":
    unittest.main()
