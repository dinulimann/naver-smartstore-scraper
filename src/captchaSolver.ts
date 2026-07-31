import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'patchright';
import { config } from './config';

const execFileAsync = promisify(execFile);

// The challenge (see README hypothesis rows 36-38) serves a small
// receipt-style image with a fill-in-the-blank question about text printed
// on it (a street number, or the Nth digit of a phone number) — not a
// distorted/adversarial CAPTCHA. Plain OCR reads the printed text reliably
// enough to answer it; no ML model or paid solving service is involved.
const ORDINALS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9,
};

interface ReceiptQuestion {
  question: string;
  image: string; // data:image/...;base64,...
}

async function runOcr(imagePath: string): Promise<string> {
  // Tesseract writes to `<outBase>.txt`; running it inside its own tempdir
  // keeps concurrent scrape attempts from clobbering each other's output.
  const outBase = imagePath.replace(/\.\w+$/, '');
  await execFileAsync(config.tesseractPath, [imagePath, outBase]);
  return readFileSync(`${outBase}.txt`, 'utf8');
}

// Only two question phrasings have actually been observed (README hypothesis
// rows 37-38). The question wording is not guaranteed to stay limited to
// these — if a question doesn't clearly match a known pattern, this
// deliberately returns null (declines to answer) rather than guessing, since
// a wrong guess is indistinguishable from a right one until the response
// comes back. Add new patterns here as new question phrasings are observed,
// rather than trying to generalize blindly ahead of evidence.
function guessAnswer(question: string, ocrText: string): string | null {
  const q = question.toLowerCase();

  // Pattern: "What is the Nth number of the store's phone number?"
  const ordinalMatch = q.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b.*phone number/);
  if (ordinalMatch) {
    const idx = ORDINALS[ordinalMatch[1]];
    // Every phone number observed so far is Korean local-number shaped:
    // exactly 3 digits, dash, exactly 4 digits (e.g. "660-4745"). Deliberately
    // NOT a flexible {2,4} here: OCR sometimes misreads the phone icon (☎) as
    // a stray leading digit glued onto the number (e.g. "2660-4745"), and a
    // flexible quantifier greedily swallows that extra digit into the match,
    // silently shifting every ordinal position by one and answering wrong
    // without any error. Requiring exactly 3 digits before the dash makes the
    // regex engine slide past a contaminating leading digit to find the real
    // boundary instead of absorbing it.
    const phoneMatch = ocrText.match(/\d{3}-\d{4}/);
    if (!phoneMatch) return null;
    const digitsOnly = phoneMatch[0].replace(/-/g, '');
    return idx < digitsOnly.length ? digitsOnly[idx] : null;
  }

  // Pattern: "The location of the store is <Street> St. [?]. (Fill the blank)"
  const cleaned = question.replace(/\(Fill the blank\)/i, '').trim();
  const blankIdx = cleaned.indexOf('[?]');
  if (blankIdx < 0) return null;
  const beforeBlank = cleaned.slice(0, blankIdx).trim();
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ocrWords = ocrText.split(/\s+/).filter(Boolean);
  const normalizedOcrWords = ocrWords.map(normalize);
  const lastWordOfPhrase = normalize(beforeBlank.split(/\s+/).slice(-1)[0]);
  if (lastWordOfPhrase.length <= 1) return null;

  for (let i = 0; i < normalizedOcrWords.length; i++) {
    if (!normalizedOcrWords[i].includes(lastWordOfPhrase)) continue;
    for (let j = i + 1; j < ocrWords.length; j++) {
      const candidate = ocrWords[j].replace(/[^a-zA-Z0-9]/g, '');
      if (candidate.length > 0) return candidate;
    }
  }
  return null;
}

/**
 * Detects the `receipt/question` CAPTCHA payload for the current page (if
 * any fired during navigation), OCRs the embedded image, and submits a
 * best-guess answer via the on-page form. Returns true if an answer was
 * submitted, false if no challenge was present or the answer couldn't be
 * determined. Caller is responsible for re-checking the page afterward —
 * a submitted answer isn't guaranteed correct, and even a correct one
 * doesn't guarantee product access without an authenticated session (see
 * README hypothesis row 37).
 */
export async function solveCaptchaIfPresent(page: Page, questionPayload: unknown): Promise<boolean> {
  if (!questionPayload || typeof questionPayload !== 'object') return false;
  const receiptData = (questionPayload as { receiptData?: ReceiptQuestion }).receiptData;
  if (!receiptData?.question || !receiptData?.image) return false;

  const scratchDir = mkdtempSync(join(tmpdir(), 'naver-captcha-'));
  try {
    const base64 = receiptData.image.replace(/^data:image\/\w+;base64,/, '');
    const imagePath = join(scratchDir, 'question.jpg');
    writeFileSync(imagePath, Buffer.from(base64, 'base64'));

    const ocrText = await runOcr(imagePath);
    const answer = guessAnswer(receiptData.question, ocrText);
    if (answer) {
      console.log(`captchaSolver: pertanyaan "${receiptData.question}" -> jawaban "${answer}"`);
    } else {
      // Logged so an unrecognized question phrasing shows up somewhere
      // instead of silently failing — the question wording isn't guaranteed
      // to stay limited to the two patterns currently handled.
      console.warn(`captchaSolver: tidak bisa menebak jawaban untuk pertanyaan: "${receiptData.question}"\nOCR text: ${ocrText.slice(0, 300)}`);
    }
    if (!answer) return false;

    const inputs = await page.$$('input[name="captcha"]');
    let filledAny = false;
    for (const input of inputs) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(answer).catch(() => undefined);
        filledAny = true;
      }
    }
    if (!filledAny) return false;

    const confirmButton = await page.$('#cpt_confirm');
    if (!confirmButton) return false;
    await confirmButton.click().catch(() => undefined);
    return true;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
