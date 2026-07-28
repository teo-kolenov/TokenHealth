#!/usr/bin/env node
/**
 * esbuild driver.
 *
 * Two bundles with different constraints:
 *   dist/code.js  — main thread; has the `figma` global, no DOM.
 *   dist/ui.html  — single file; Figma requires the UI as one HTML document, so
 *                   the JS is inlined at the <!--BUNDLE--> marker.
 *
 * The dashboard template is pulled in through esbuild's `text` loader, so there
 * is exactly one copy of it in the bundle and no codegen step.
 */
import esbuild from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  target: 'es2018',
  format: 'iife',
  logLevel: 'info',
  minify: !watch,
  absWorkingDir: root,
  loader: { '.html': 'text', '.css': 'text', '.woff2': 'dataurl' },
};

async function buildMain(ctx) {
  const options = { ...shared, entryPoints: ['src/main/code.ts'], outfile: 'dist/code.js' };
  if (ctx) return esbuild.context(options);
  return esbuild.build(options);
}

async function buildUi() {
  const bundle = await esbuild.build({
    ...shared,
    entryPoints: ['src/ui/ui.ts'],
    write: false,
    outfile: 'dist/ui.bundle.js',
  });

  const shell = await readFile(resolve(root, 'src/ui/ui.html'), 'utf8');
  // Guard against a future template revision that embeds script markup.
  const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

  await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(resolve(root, 'dist/ui.html'), shell.replace('<!--BUNDLE-->', `<script>${js}</script>`), 'utf8');
  return bundle;
}

/**
 * Preview harness: the real UI bundle plus a stand-in for the Figma main thread.
 * Lets the plugin be driven end to end in a browser, with only the Figma API
 * mocked. Not shipped — `dist/preview/` is excluded from the plugin bundle.
 */
async function buildPreview() {
  const outdir = resolve(root, 'dist/preview');
  await mkdir(outdir, { recursive: true });

  await esbuild.build({
    ...shared,
    entryPoints: ['src/preview/harness.ts'],
    outfile: 'dist/preview/harness.js',
    minify: false,
  });

  await copyFile(resolve(root, 'src/preview/index.html'), resolve(outdir, 'index.html'));
  // The preview loads the real built UI, so it stays honest as the plugin changes.
  await copyFile(resolve(root, 'dist/ui.html'), resolve(outdir, 'ui.html'));
}

if (watch) {
  const mainCtx = await buildMain(true);
  await mainCtx.watch();
  await buildUi();
  await buildPreview();

  const { watch: fsWatch } = await import('node:fs');
  const rebuild = debounce(async () => {
    try {
      await buildUi();
      await buildPreview();
      console.log('[watch] ui + preview rebuilt');
    } catch (error) {
      console.error('[watch] ui build failed:', error.message);
    }
  }, 120);

  for (const dir of ['src/ui', 'src/analysis', 'src/shared', 'src/preview']) {
    fsWatch(resolve(root, dir), { recursive: true }, rebuild);
  }
  console.log('[watch] watching for changes…');
} else {
  await buildMain(false);
  await buildUi();
  await buildPreview();
  console.log('build complete → dist/code.js, dist/ui.html, dist/preview/index.html');
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
