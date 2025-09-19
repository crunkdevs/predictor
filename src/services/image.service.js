import crypto from 'crypto';
import mime from 'mime-types';
import { insertOrGetImage } from '../models/image.model.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function saveImage(buffer, fileName = 'unnamed') {
  if (!buffer || !buffer.length) throw new Error('Empty buffer');

  const hash = sha256(buffer);
  const mimeType = mime.lookup(fileName) || 'application/octet-stream';

  const { row } = await insertOrGetImage({
    fileName,
    mimeType,
    fileSize: buffer.length,
    sha256: hash,
    buffer,
  });

  return row;
}
