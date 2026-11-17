// Shared WGSL loader for the checker and the build, so both see exactly the same module text.
//
// tools/modules.json lists, per module, the source files to concatenate in order.
// An entry "solid.wgsl@rock" stamps a template: the file is included with every SURF replaced by "rock".
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const STAMP_TOKEN = 'SURF';

export function readManifest(root) {
  return JSON.parse(readFileSync(path.join(root, 'tools', 'modules.json'), 'utf8'));
}

/** @returns {{[name: string]: {code: string, map: {file: string, start: number, end: number}[]}}} */
export function loadModules(root, manifest = readManifest(root)) {
  const modules = {};
  for (const [name, files] of Object.entries(manifest.modules)) {
    let code = ''; let line = 1; const map = [];
    for (const entry of files) {
      const [file, stamp] = entry.split('@');
      let src = readFileSync(path.join(root, 'src', file), 'utf8').replace(/\r\n/g, '\n');
      if (stamp) src = src.replaceAll(STAMP_TOKEN, stamp);
      const n = src.split('\n').length;
      map.push({ file: entry, start: line, end: line + n - 1 });
      code += src + '\n';
      line += n;
    }
    modules[name] = { code, map };
  }
  return modules;
}

export function locate(module, line) {
  const m = module.map.find(x => line >= x.start && line <= x.end);
  return m ? `src/${m.file}:${line - m.start + 1}` : `line ${line}`;
}

// Pairs of characters that must not be joined, because together they would lex as a different token.
const KEEP_APART = new Set(['--', '++', '&&', '||', '/*', '//', '<<', '>>', '==', '-=', '+=', '*=', '/=', '<=', '>=', '!=', '->', '=>']);
const isWord = c => /[A-Za-z0-9_]/.test(c);

/** Strip comments and all whitespace that is not needed to keep tokens apart. No renaming. */
export function minifyWGSL(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const parts = text.split(/\s+/).filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (out) {
      const a = out[out.length - 1], b = p[0];
      if ((isWord(a) && isWord(b)) || KEEP_APART.has(a + b)) out += ' ';
    }
    out += p;
  }
  return out;
}
