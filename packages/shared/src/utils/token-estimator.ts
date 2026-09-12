/** Lightweight, model-agnostic token estimate based on Unicode script. */
export function estimateTextTokens(text: string): number {
  let hundredthTokens = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0)!;

    if (isHangul(codePoint)) {
      hundredthTokens += 50;
    } else if (isHan(codePoint)) {
      hundredthTokens += 67;
    } else if (isKana(codePoint)) {
      hundredthTokens += 67;
    } else {
      hundredthTokens += 25;
    }
  }

  return Math.ceil(hundredthTokens / 100);
}

function isHangul(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}

function isHan(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x323af)
  );
}

function isKana(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9f) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b16f)
  );
}
