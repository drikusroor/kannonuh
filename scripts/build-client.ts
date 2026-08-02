/** Bundles the browser client into public/. */
import { rm, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'public');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

async function build(): Promise<boolean> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(root, 'src/client/main.ts')],
    outdir: out,
    target: 'browser',
    format: 'esm',
    splitting: true,
    sourcemap: dev ? 'linked' : 'none',
    minify: !dev,
    define: {
      __DISCORD_CLIENT_ID__: JSON.stringify(process.env.DISCORD_CLIENT_ID ?? ''),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }

  await cp(join(root, 'src/client/index.html'), join(out, 'index.html'));
  await cp(join(root, 'src/client/styles.css'), join(out, 'styles.css'));

  const bytes = result.outputs.reduce((a, o) => a + o.size, 0);
  console.log(`built client → public/ (${result.outputs.length} files, ${(bytes / 1024).toFixed(1)} kB)`);
  return true;
}

const ok = await build();
if (!ok && !watch) process.exit(1);

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer: ReturnType<typeof setTimeout> | null = null;
  for (const dir of ['src/client', 'src/shared']) {
    fsWatch(join(root, dir), { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void build(), 120);
    });
  }
  console.log('watching for client changes…');
}
