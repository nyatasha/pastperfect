/**
 * Offline classification of museum metadata.
 *
 * These are the signals the PRD assigns to AI: what part of the world an object
 * comes from, and whether it *reads* older or newer than it is. They are
 * computed once, at ingest time, from metadata only -- never during play, and
 * never as an input to the answer itself.
 *
 * The rules below are deliberately transparent keyword heuristics. They are the
 * seam where an offline model pass would slot in later; the rest of the
 * codebase only consumes the columns they write.
 */

export const REGIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["East Asia", /china|chinese|japan|japanese|korea|korean|tibet|mongolia|qing|ming|edo|meiji/i],
  ["South Asia", /india|indian|nepal|pakistan|sri lanka|bengal|mughal|gandhara/i],
  ["Southeast Asia", /thai|thailand|vietnam|cambodia|indonesia|java|burma|myanmar|philippin/i],
  ["Middle East", /iran|persia|persian|turkey|turkish|ottoman|syria|iraq|arab|islamic|levant|anatolia/i],
  ["Africa", /egypt|nubia|nigeria|ghana|congo|mali|ethiopia|morocco|benin|yoruba|african/i],
  ["Oceania", /australia|new zealand|maori|polynes|melanes|hawai|papua|oceania/i],
  ["Latin America", /mexico|mexican|peru|peruvian|brazil|maya|aztec|inca|colombia|argentin|chile/i],
  ["North America", /united states|american|america|canada|canadian|navajo|hopi|new york|boston|chicago/i],
  [
    "Europe",
    /france|french|italy|italian|netherland|dutch|holland|german|britain|british|england|english|spain|spanish|belgi|flemish|austria|swiss|switzerland|sweden|swedish|denmark|danish|norway|russia|russian|poland|polish|greece|greek|roman|scotland|scottish|ireland|irish|portug|hungar|czech/i,
  ],
];

/**
 * Object types that most people file mentally under "modern", whatever their
 * actual date. Deliberately narrow: "furniture" or "geometric" would sweep in
 * baroque cabinets and Islamic tilework, neither of which reads modern.
 */
const READS_MODERN =
  /photograph|photomechanical|negative|daguerreotype|albumen|gelatin silver|calotype|tintype|ambrotype|cyanotype|collotype|poster|advertis|typograph|graphic design|industrial design|product design|bakelite|plastic|aluminium|aluminum|chromium|chrome-plated|neon|abstract/i;

/** Types that read old regardless of date -- a 1930s icon still looks medieval. */
const READS_OLD =
  /icon|illuminat|manuscript|fresco|altarpiece|reliquar|tapestr|vellum|parchment|papyrus|amphora|sarcophag|mosaic|panel painting|tempera/i;

/** Short human labels for the object's form, used in the reveal one-liner. */
const FORMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["photograph", /photograph|daguerreotype|albumen|gelatin silver|negative|calotype/i],
  ["print", /\bprint\b|etching|engraving|lithograph|woodcut|woodblock|aquatint|mezzotint/i],
  ["drawing", /drawing|sketch|watercolou?r|gouache|pastel|charcoal|graphite|chalk/i],
  ["painting", /painting|oil on|tempera|canvas|panel|fresco/i],
  ["sculpture", /sculpture|statue|bronze|marble|carving|relief|terracotta figure/i],
  ["textile", /textile|tapestr|embroider|silk|cotton|weaving|quilt|costume|dress|garment/i],
  ["ceramic", /ceramic|porcelain|stoneware|earthenware|pottery|vase|jar|bowl|plate/i],
  ["book or manuscript", /manuscript|book|folio|album|codex|illuminat|page[s]? /i],
  ["furniture", /furniture|chair|table|cabinet|desk|chest/i],
  ["metalwork", /silver|gold|pewter|iron|steel|brass|jewel|armou?r|coin|medal/i],
  ["poster", /poster|placard|broadside/i],
  ["map", /\bmap\b|chart|atlas|cartograph/i],
  ["vessel", /vessel|pitcher|ewer|flask|amphora|beaker|goblet|chalice|urn/i],
  ["amulet", /amulet|talisman|charm/i],
  ["stele", /\bstele|stelae\b/i],
  ["architectural fragment", /architectural|capital \(|column|frieze|lintel/i],
  ["mask", /\bmask\b/i],
  ["seal", /\bseal\b|signet|stamp/i],
  ["instrument", /instrument|violin|flute|drum|lute|guitar/i],
  ["weapon", /weapon|sword|dagger|firearm|pistol|rifle|helmet|shield/i],
];

/**
 * Classifications that answer neither "what is it" nor "what is it made of"
 * usefully. Two kinds live here.
 *
 * Materials: a classification reading "limestone" tells a sentence nothing, and
 * tells a player staring at two pictures even less.
 *
 * Vague headings: Wellcome files two hundred engravings under "Pictures", which
 * is precisely the label a player complains about -- it does not say whether
 * they are looking at a painting, a print or a photograph. Falling through to
 * the medium finds the answer, because the medium says "Engravings".
 */
const VAGUE_WORDS = new Set([
  // materials
  "stone", "limestone", "sandstone", "marble", "granite", "wood", "lacquer",
  "ivory", "bone", "glass", "paper", "clay", "bronze", "iron", "gold", "silver",
  "metal", "jade", "tempera", "oil", "acrylic", "ink", "chalk", "gouache",
  "watercolor", "watercolour", "faience",
  // headings that name a department, not a thing
  "picture", "image", "artwork", "work", "art", "asian art", "photography",
  "mixed media", "liturgical", "textile material", "design",
  "unidentified", "other", "miscellaneous",
]);

/** Longer than any English word a museum uses to classify an object. */
const MAX_CLASSIFICATION_WORD = 16;

type Field = string | null | undefined;

const join = (fields: readonly Field[]): string => fields.filter(Boolean).join(" ");

export function regionFor(...fields: Field[]): string {
  const text = join(fields).toLowerCase();
  if (!text.trim()) return "Unknown";
  for (const [name, pattern] of REGIONS) if (pattern.test(text)) return name;
  return "Unknown";
}

function singular(word: string): string {
  if (/(ss|us|is|ae)$/.test(word) || !word.endsWith("s")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.slice(0, -1);
}

/**
 * The museum's own classification, when it reads like a thing rather than a
 * substance. "Furniture" and "Amulets" qualify; "Limestone" and "Other" do not.
 */
function classificationNoun(classification: Field): string | null {
  let word = (classification ?? "").replace(/\(.*?\)/g, "").trim().toLowerCase();
  if (!word || !/^[a-z ]+$/.test(word)) return null;
  const words = word.split(/\s+/);
  if (words.length > 2 || words.some((part) => part.length > MAX_CLASSIFICATION_WORD)) return null;
  word = singular(word);
  return VAGUE_WORDS.has(word) ? null : word;
}

/**
 * A short noun for the object.
 *
 * The museum's classification comes first, because it is a curator saying what
 * the thing is, while `medium` is a list of what it is made of. A gilt-bronze
 * coffer has "bronze" in its medium and is not a sculpture; the Art Institute
 * already knows to file it under furniture. Keyword matching on the medium is
 * the fallback for the collections that publish no classification at all.
 */
export function formFor(...fields: Field[]): string {
  const noun = classificationNoun(fields[1]);
  if (noun) return noun;
  const text = join(fields);
  for (const [name, pattern] of FORMS) if (pattern.test(text)) return name;
  return "object";
}

/**
 * The form label a player is shown *before* answering.
 *
 * Same noun as `formFor`, capitalised for a card, and hardened for its place in
 * the pre-answer payload: a digit anywhere in the museum's own classification
 * would be a date leak, so anything containing one falls back to "Object".
 */
export function displayForm(...fields: Field[]): string {
  const word = formFor(...fields);
  if (/\d/.test(word)) return "Object";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** True when the object's form makes it look newer than it is. */
export function readsModern(...fields: Field[]): boolean {
  const text = join(fields);
  if (READS_OLD.test(text)) return false;
  return READS_MODERN.test(text);
}

export function readsOld(...fields: Field[]): boolean {
  return READS_OLD.test(join(fields));
}
