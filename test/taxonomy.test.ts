/**
 * The offline classifiers.
 *
 * `displayForm` is the only one of these whose output reaches a player *before*
 * they answer, so it carries the same burden as the contract: it may say what a
 * thing is, and it may never say when it was made. Everything else here is a
 * heuristic whose worst failure is a duller sentence.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayForm, formFor, readsModern, readsOld, regionFor } from "../src/taxonomy.ts";

describe("form labels", () => {
  it("takes the museum's own classification first", () => {
    assert.equal(formFor("Albumen silver print from glass negative", "Photographs", ""), "photograph");
    assert.equal(formFor("Oil on canvas", "Paintings", ""), "painting");
    assert.equal(formFor("Colour lithograph", "Posters", ""), "poster");
    assert.equal(formFor("Faience", "Amulets", "Scarab"), "amulet");
    assert.equal(formFor("Feathers", "Fans", "Folding fan"), "fan");
  });

  /**
   * The reason the classification wins. A gilt-bronze coffer has "bronze" in
   * its medium and is emphatically not a sculpture; the museum filed it under
   * furniture, and the museum is right.
   */
  it("does not mistake what a thing is made of for what it is", () => {
    assert.equal(
      formFor("Oak veneered with tortoiseshell, brass and gilt bronze", "Furniture", "Coffer"),
      "furniture",
    );
    assert.equal(formFor("Silk and metal thread", "Textiles", "Chasuble"), "textile");
  });

  it("falls back to the medium when a museum publishes no classification", () => {
    assert.equal(formFor("Gelatin silver print", "", "Untitled"), "photograph");
    assert.equal(formFor("Etching and aquatint", null, "A view"), "print");
  });

  /**
   * The label a player actually complained about. Wellcome files hundreds of
   * engravings under "Pictures", which does not say whether you are looking at
   * a painting, a print or a photograph -- and the medium always does.
   */
  it("refuses a heading that names a department rather than a thing", () => {
    assert.equal(formFor("Engravings", "Pictures", "A portrait"), "print");
    assert.equal(formFor("Woodcuts, Title pages", "Pictures", ""), "print");
    assert.equal(formFor("Photographic print", "Photography", ""), "photograph");
    // Nothing salvageable in either field is still better than a wrong answer.
    assert.equal(formFor("Jade", "Jade", ""), "object");
  });

  it("ignores a classification that is not a word a museum would use", () => {
    // Rijksmuseum publishes some compounds no English label should inherit.
    assert.equal(formFor("Oil on canvas", "Interieuronderdeel", ""), "painting");
  });

  it("refuses a classification that names a substance rather than a thing", () => {
    // "Limestone" tells a sentence nothing: the object is still an object.
    assert.equal(formFor("Limestone", "Stone", ""), "object");
  });

  it("capitalises for a card", () => {
    assert.equal(displayForm("Oil on canvas", "Paintings", ""), "Painting");
    assert.equal(displayForm("Feathers", "Fans", "Folding fan"), "Fan");
  });

  /**
   * The one that guards the payload. A classification carrying a year would
   * date the object on the board, before the player has committed.
   */
  it("never puts a digit in front of a player who has not answered", () => {
    assert.equal(displayForm("Unknown", "Prints 1800", ""), "Object");
    assert.equal(displayForm("", "", ""), "Object");
    for (const spec of [
      ["Albumen print", "Photographs", "Portrait, 1867"],
      ["Silver", "Metalwork", "Coin of 41 BC"],
      ["Wool", "Textiles 1920s", ""],
      ["Oil on canvas", "Paintings", "View of 1830"],
    ] as const) {
      assert.doesNotMatch(displayForm(...spec), /\d/, spec.join(" / "));
    }
  });
});

describe("region and reading age", () => {
  it("places an object from its culture", () => {
    assert.equal(regionFor("Japan"), "East Asia");
    assert.equal(regionFor("Netherlands"), "Europe");
    assert.equal(regionFor(""), "Unknown");
  });

  it("knows which forms read newer than they are", () => {
    assert.equal(readsModern("Gelatin silver print", "Photographs", ""), true);
    // An illuminated page reads medieval whatever the date on it says.
    assert.equal(readsModern("Gouache on vellum", "Illuminated manuscript", ""), false);
    assert.equal(readsOld("Tempera on panel", "Icon", ""), true);
  });
});
