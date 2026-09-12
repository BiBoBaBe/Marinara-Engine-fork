import assert from "node:assert/strict";
import { estimateTextTokens } from "../../packages/shared/src/utils/token-estimator.js";
import { estimateCharacterCardTokens } from "../../packages/client/src/lib/character-token-count.js";

assert.equal(estimateTextTokens(""), 0);
assert.equal(estimateTextTokens("abcdefghijkl"), 3, "Latin text should retain the four-characters-per-token estimate");
assert.equal(estimateTextTokens("가나다라마바사아"), 4, "Hangul should estimate two characters per token");
assert.equal(estimateTextTokens("漢字漢字漢字"), 5, "Han characters should use their own 0.67 weight");
assert.equal(estimateTextTokens("あいうえおか"), 5, "Hiragana should use the Kana 0.67 weight");
assert.equal(estimateTextTokens("アイウエオカ"), 5, "Katakana should use the Kana 0.67 weight");
assert.equal(estimateTextTokens("ab가漢ア"), 3, "mixed scripts should add their per-code-point weights");
assert.equal(estimateTextTokens("😀😀😀😀"), 1, "non-CJK astral characters should be counted by Unicode code point");

const koreanCardDescription = "가나다라마바사아";
assert.equal(
  estimateCharacterCardTokens({ description: koreanCardDescription }),
  4,
  "character cards should display the shared token estimate, not their raw character count",
);
