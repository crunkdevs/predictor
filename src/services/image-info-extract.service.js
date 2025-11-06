import OpenAI from 'openai';
import { getImageBase64 } from './image.base64.service.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function parseGameScreenshot(imageId) {
  const { base64, mime } = await getImageBase64(imageId);

  const imageUrl = `data:${mime};base64,${base64}`;

  const resp = await client.responses.create({
    model: process.env.IMG_PARSE_MODEL || 'gpt-4o-mini',
    temperature: 0,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `
Extract structured fields from this image. Follow these rules strictly:

Return ONLY valid JSON (no markdown, no comments, no trailing commas) in this schema:
{
  "numbers": [number, number, number],
  "result": number
}

Rules:
- "numbers": the three small numbers at the very top (left→right).
- "result": the BIG central number inside the inner circle.
- Return ONLY the JSON.
`.trim(),
          },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
  });

  const raw =
    resp.output_text?.trim() ??
    resp.output?.[0]?.content?.find?.((c) => typeof c.text === 'string')?.text?.trim();

  if (!raw) {
    throw new Error('❌ No text returned from model');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`❌ Could not parse JSON: ${raw}`);
    parsed = JSON.parse(m[0]);
  }

  const numbers = Array.isArray(parsed.numbers)
    ? parsed.numbers.map((n) => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  const result = Number.isFinite(parseInt(parsed.result, 10)) ? parseInt(parsed.result, 10) : null;

  return { numbers, result };
}
