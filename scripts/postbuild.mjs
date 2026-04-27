import { mkdir, writeFile, copyFile } from 'node:fs/promises';

await mkdir('extension/js/js', { recursive: true });

await writeFile(
  'extension/js/rolldown-runtime.js',
  'export function t(factory){const exports={};const value=factory(exports);return value??exports;}'
);

await writeFile('extension/js/modulepreload-polyfill.js', '// noop\n');

await writeFile(
  'extension/js/js/bundle.js',
  'export function t(e){try{let t=new URL(e);if(t.hostname!==`www.instagram.com`&&t.hostname!==`instagram.com`)return null;let n=t.pathname.replace(/\\/$/,``).split(`/`).filter(Boolean);if(n.length===0)return null;let[r,i,a]=n;if(r===`p`&&i)return{type:`post`,shortcode:i,carouselIndex:t.searchParams.has(`img_index`)?parseInt(t.searchParams.get(`img_index`))-1:void 0};if(r===`reel`&&i)return{type:`reel`,shortcode:i};if(r===`stories`){if(i===`highlights`&&a)return{type:`highlight`,highlightId:a};if(i)return{type:`story`,username:i}}return null}catch{return null}}'
);

await copyFile('manifest.json', 'extension/manifest.json');
await mkdir('extension/icons', { recursive: true });
await copyFile('icons/icon-16.png', 'extension/icons/icon-16.png');
await copyFile('icons/icon-48.png', 'extension/icons/icon-48.png');
await copyFile('icons/icon-96.png', 'extension/icons/icon-96.png');
await copyFile('icons/icon.svg', 'extension/icons/icon.svg');
