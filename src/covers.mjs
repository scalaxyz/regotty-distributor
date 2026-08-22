// Cover-art picker: takes one image from covers/, and consumes (deletes) it once
// the release is uploaded so it is never reused.

import { readdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';

const IMG = /\.(jpe?g|png)$/i;

export async function listCovers(coversDir) {
  let files = [];
  try { files = await readdir(coversDir); } catch { return []; }
  return files.filter((f) => IMG.test(f)).sort().map((f) => path.join(coversDir, f));
}

/** The next cover to use (first alphabetically), or null if the folder is empty. */
export async function pickCover(coversDir) {
  const covers = await listCovers(coversDir);
  return covers[0] || null;
}

/** Copy the chosen cover into the release folder (so we keep a record), then delete the original. */
export async function consumeCover(coverPath, destDir) {
  const dest = path.join(destDir, `cover${path.extname(coverPath).toLowerCase()}`);
  await copyFile(coverPath, dest);
  await unlink(coverPath).catch(() => {});
  return dest;
}
