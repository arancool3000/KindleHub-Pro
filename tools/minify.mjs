// Produce a minified deploy artifact (index.min.html) from the readable source.
// We do NOT use an HTML minifier: this file's JS contains `<script>`/`</script>`
// inside template literals (the HTML editor/preview) AND `<script>` appears as
// text inside HTML comments — both break HTML parsers. Instead a tiny top-level
// scanner walks the document, SKIPPING <!-- --> comments, and minifies the body
// of each real <script>/<style> block with terser / clean-css (correct parsers),
// leaving all surrounding bytes identical.
//
// Old-WebKit (Kindle Silk) safe: terser runs with compress:false, mangle:false
// (strip JS comments+whitespace only — no code transforms, no renaming, so
// cross-<script> globals + inline onclick handlers can't break). clean-css L1.
//
// Run:  cd tools && npm install && node minify.mjs
import { minify as terserMinify } from 'terser';
import CleanCSS from 'clean-css';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '..', 'index.html');
const OUT = join(__dir, '..', 'index.min.html');
const src = readFileSync(SRC, 'utf8');
const cleaner = new CleanCSS({ level: 1, compatibility: 'ie8' });

function nextTag(s, from) {
  // earliest of: <!--, <script\b, <style\b  (case-insensitive for tags)
  const c = s.indexOf('<!--', from);
  const re = /<(script|style)\b/ig; re.lastIndex = from;
  const t = re.exec(s);
  const cand = [];
  if (c >= 0) cand.push({ pos: c, kind: 'comment' });
  if (t) cand.push({ pos: t.index, kind: t[1].toLowerCase() });
  if (!cand.length) return null;
  cand.sort((a, b) => a.pos - b.pos);
  return cand[0];
}

async function run() {
  let out = '', pos = 0, jsBlocks = 0, cssBlocks = 0, errors = [];
  while (pos < src.length) {
    const tag = nextTag(src, pos);
    if (!tag) { out += src.slice(pos); break; }
    out += src.slice(pos, tag.pos);
    if (tag.kind === 'comment') {
      const end = src.indexOf('-->', tag.pos + 4);
      const e = end < 0 ? src.length : end + 3;
      out += src.slice(tag.pos, e); pos = e; continue;        // keep comment verbatim (HTML minify not our job)
    }
    // real <script> or <style>: copy the open tag, minify body, copy close tag
    const gt = src.indexOf('>', tag.pos);
    const openTag = src.slice(tag.pos, gt + 1);
    const closeTok = tag.kind === 'script' ? '</script' : '</style';
    let ce = src.toLowerCase().indexOf(closeTok, gt + 1);
    while (ce >= 0) { // ensure it's a real close tag (next non-space char is '>')
      let k = ce + closeTok.length; while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === '>') break;
      ce = src.toLowerCase().indexOf(closeTok, ce + closeTok.length);
    }
    if (ce < 0) { out += src.slice(tag.pos); break; }
    const closeEnd = src.indexOf('>', ce) + 1;
    const body = src.slice(gt + 1, ce);
    const closeTag = src.slice(ce, closeEnd);

    if (tag.kind === 'script') {
      const type = (/type\s*=\s*["']([^"']+)["']/i.exec(openTag) || [])[1];
      if (type && !/javascript|module|ecmascript/i.test(type)) { out += openTag + body + closeTag; }
      else {
        try {
          const res = await terserMinify(body, { compress: false, mangle: false, format: { comments: false }, sourceMap: false });
          if (res.code === undefined) throw new Error('no output');
          out += openTag + res.code + closeTag; jsBlocks++;
        } catch (e) { errors.push('JS @' + tag.pos + ': ' + e.message); out += openTag + body + closeTag; }
      }
    } else {
      try {
        const res = cleaner.minify(body);
        if (res.errors && res.errors.length) throw new Error(res.errors.join('; '));
        out += openTag + res.styles + closeTag; cssBlocks++;
      } catch (e) { errors.push('CSS @' + tag.pos + ': ' + e.message); out += openTag + body + closeTag; }
    }
    pos = closeEnd;
  }

  if (errors.length) { console.error('MINIFY ERRORS:\n' + errors.join('\n')); process.exit(1); }
  writeFileSync(OUT, out);
  const before = Buffer.byteLength(src), after = Buffer.byteLength(out);
  console.log(`minified ${jsBlocks} JS + ${cssBlocks} CSS blocks`);
  console.log(`index.html ${(before/1048576).toFixed(2)} MB -> index.min.html ${(after/1048576).toFixed(2)} MB (${(((before-after)/before)*100).toFixed(1)}% smaller)`);
}
run();
