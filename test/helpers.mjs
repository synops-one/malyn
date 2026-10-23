import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function cleanup(directory) {
  const target=await fs.realpath(directory);
  const temp=await fs.realpath(os.tmpdir());
  const relative=path.relative(temp,target);
  if(path.isAbsolute(relative)||relative.startsWith('..')||relative.includes(path.sep)||!relative.startsWith('malyn-'))throw new Error('Unexpected test cleanup target.');
  await fs.rm(target,{recursive:true,force:true});
}
