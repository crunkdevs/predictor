import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import { saveImage } from '../services/image.service.js';

const WATCH_DIR = process.env.WATCH_DIR || './captures';
const ROOT = path.resolve(WATCH_DIR);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.heic']);
const isImage = (p) => IMAGE_EXTS.has(path.extname(p).toLowerCase());

export async function ingestBatch(limit = 200) {
  await fs.mkdir(ROOT, { recursive: true });

  const files = await fg(['**/*.*'], {
    cwd: ROOT,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });

  const batch = files.filter(isImage).slice(0, limit);

  if (!batch.length) {
    console.log('— nothing found this tick');
    return;
  }

  for (const absPath of batch) {
    const relPath = path.relative(ROOT, absPath).split(path.sep).join('/');
    try {
      const buffer = await fs.readFile(absPath);
      await saveImage(buffer, relPath);
      await fs.rm(absPath, { force: true });
      console.log(`✔ processed & removed: ${relPath}`);
    } catch (err) {
      console.error(`✘ failed: ${relPath} → ${err.message}`);
    }
  }
}
