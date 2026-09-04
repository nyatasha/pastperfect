"""The two palettes.

Dark mode is a token swap, which only works while two things stay true: every
colour lives in a token, and both dark blocks stay in step with each other. Both
are easy to break by adding one component rule, so both are tested.
"""

from __future__ import annotations

import re
import unittest

from pastperfect import config

CSS = (config.STATIC_DIR / "css" / "app.css").read_text("utf-8")

#: Tokens whose light values would be unreadable on a dark ground. Every one of
#: them has to be redefined by both dark blocks.
MUST_INVERT = {
    "--ivory", "--ivory-warm", "--ivory-deep", "--ink", "--ink-2", "--ink-3",
    "--line", "--line-soft", "--accent", "--correct", "--shadow-card",
    "--shadow-lift", "--frame-sheen", "--art-shadow", "--chip", "--halo",
    "--ivory-fade", "--on-accent",
}


def block(selector: str) -> str:
    """The body of the first rule whose selector starts with ``selector``."""
    start = CSS.index(selector)
    open_brace = CSS.index("{", start)
    depth, index = 1, open_brace + 1
    while depth and index < len(CSS):
        depth += (CSS[index] == "{") - (CSS[index] == "}")
        index += 1
    return CSS[open_brace + 1 : index - 1]


def tokens(text: str) -> set[str]:
    return set(re.findall(r"(--[a-z0-9-]+)\s*:", text))


LIGHT = tokens(block(":root {"))
SYSTEM_DARK = tokens(block(':root:not([data-theme="light"]) {'))
CHOSEN_DARK = tokens(block(':root[data-theme="dark"] {'))


class Palettes(unittest.TestCase):
    def test_light_palette_is_the_full_set(self):
        self.assertTrue(MUST_INVERT.issubset(LIGHT), MUST_INVERT - LIGHT)

    def test_the_two_dark_blocks_do_not_drift_apart(self):
        """A viewer whose system is dark and one who chose dark see one design."""
        self.assertEqual(SYSTEM_DARK, CHOSEN_DARK,
                         SYSTEM_DARK.symmetric_difference(CHOSEN_DARK))

    def test_dark_redefines_everything_that_must_invert(self):
        for palette, name in ((SYSTEM_DARK, "system dark"), (CHOSEN_DARK, "chosen dark")):
            self.assertTrue(MUST_INVERT.issubset(palette),
                            f"{name} is missing {MUST_INVERT - palette}")

    def test_dark_defines_no_token_light_has_not(self):
        """Catches a typo that would silently fall back to an inherited value."""
        for palette, name in ((SYSTEM_DARK, "system dark"), (CHOSEN_DARK, "chosen dark")):
            self.assertTrue(palette.issubset(LIGHT), f"{name} has stray {palette - LIGHT}")

    def test_system_dark_yields_to_an_explicit_light_choice(self):
        self.assertIn(':root:not([data-theme="light"])', CSS)


class NoLooseColours(unittest.TestCase):
    """Every colour has to come from a token, or dark mode rots as the CSS grows."""

    LITERAL = re.compile(r"#[0-9A-Fa-f]{3,8}\b|\brgba?\(")

    def test_no_colour_literal_outside_the_palette_blocks(self):
        stripped = CSS
        for selector in (":root {", ':root:not([data-theme="light"]) {',
                         ':root[data-theme="dark"] {'):
            stripped = stripped.replace(block(selector), "")
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.S)
        offenders = [
            line.strip() for line in stripped.splitlines() if self.LITERAL.search(line)
        ]
        self.assertEqual(offenders, [], f"colour literals outside the palettes: {offenders}")


if __name__ == "__main__":
    unittest.main()
