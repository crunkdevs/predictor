import OpenAI from 'openai';
import { getImageBase64 } from './image.base64.service.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function parseGameScreenshot(imageId) {
  const base64 = await getImageBase64(imageId);

  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
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
  "result": number,
}

Rules:
- "numbers": the three small numbers at the very top (left→right).
- "result": the BIG central number inside the inner circle.
- Return ONLY the JSON.

`.trim(),
          },
          { type: 'input_image', image_url: base64 },
        ],
      },
    ],
  });

  const text = resp.output?.[0]?.content?.[0]?.text?.trim();
  if (!text) {
    throw new Error('❌ No text returned from model');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`❌ Could not parse JSON: ${text}`, err);
  }

  return {
    numbers: Array.isArray(parsed.numbers)
      ? parsed.numbers.map((n) => parseInt(n, 10)).filter(Number.isFinite)
      : [],
    result: Number.isFinite(parseInt(parsed.result, 10)) ? parseInt(parsed.result, 10) : null,
  };
}
