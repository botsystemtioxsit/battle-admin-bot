#!/usr/bin/env node
// Builds public/admin.html (minified+mangled) from src/admin.html.
//
// - Reads src/admin.html.
// - Finds every inline <script>...</script> block that does NOT have a
//   src= attribute (CDN <script src="..."> tags are left completely
//   untouched).
// - Runs each inline script's contents through terser with a conservative,
//   semantics-preserving config (mangle names, no unsafe compress options,
//   keep console.* calls, strip comments).
// - Reassembles the HTML with the minified script contents in place and
//   writes it to public/admin.html, prefixed with an auto-generated
//   header comment.
// - Stamps the build: the two placeholders '__BUILD_ID__' / '__BUILD_TIME__'
//   in src (the page's auto-update block) are replaced with a hash of src and
//   the build time, and the same pair is written to public/build-id.json next
//   to the page. An open panel asks for that tiny file every few minutes and
//   reloads itself when it is newer than the copy it was built from.
// - Exits non-zero (and never writes a partial/corrupt file) if any script
//   block fails to minify.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { minify } = require('terser');

const SRC_PATH = path.join(__dirname, '..', '..', 'src', 'admin.html');
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'admin.html');
const BUILD_ID_PATH = path.join(__dirname, '..', '..', 'public', 'build-id.json');

const HEADER_COMMENT = `<!--
  AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
  This is a minified/mangled build of src/admin.html, produced by
  .github/workflows/build-obfuscated.yml on every push to src/admin.html.
  Edit src/admin.html instead — this file will be regenerated automatically.
-->
`;

// Matches an opening <script ...> tag without a src= attribute, its body,
// and the closing </script> tag. Mirrors the repo's own validation regex
// (see CLAUDE.md) but captures the opening tag separately so we can keep
// its attributes exactly as they were.
const SCRIPT_BLOCK_RE = /<script((?:(?!src=)[^>])*)>([\s\S]*?)<\/script>/gi;

async function main() {
  const srcHtml = fs.readFileSync(SRC_PATH, 'utf8');

  // The id is a hash of the source itself (same source -> same id), the time
  // only orders builds so a page never "updates" to an older file that a
  // stale cache happened to serve. Both are substituted BEFORE minifying so
  // terser sees plain constants. The build fails if the placeholders are
  // missing or duplicated: without them the panel would silently lose its
  // auto-update.
  const buildId = crypto.createHash('sha256').update(srcHtml).digest('hex').slice(0, 12);
  // Повторная сборка того же исходника (запуск workflow вручную) не должна
  // менять ни страницу, ни build-id.json — иначе в main появлялся бы пустой
  // коммит-«обновление»: берём время прошлой сборки с тем же id.
  let builtAt = Date.now();
  try {
    const prev = JSON.parse(fs.readFileSync(BUILD_ID_PATH, 'utf8'));
    if (prev && prev.id === buildId && Number.isFinite(prev.t) && prev.t > 0) builtAt = prev.t;
  } catch (e) { /* первой сборки ещё нет или файл повреждён — берём текущее время */ }
  for (const placeholder of ["'__BUILD_ID__'", "'__BUILD_TIME__'"]) {
    const count = srcHtml.split(placeholder).length - 1;
    if (count !== 1) {
      console.error(`Build failed: ${placeholder} must appear exactly once in src/admin.html, found ${count}.`);
      process.exit(1);
    }
  }
  const html = srcHtml
    .replace("'__BUILD_ID__'", `'${buildId}'`)
    .replace("'__BUILD_TIME__'", `'${builtAt}'`);
  // Human-readable version (only for the JSON file, handy to see what is live).
  const versionMatch = srcHtml.match(/id="admin-version"[^>]*>[^<]*?(v\d+\.\d+(?:\.\d+)?)/);

  const matches = [...html.matchAll(SCRIPT_BLOCK_RE)];

  let result = '';
  let lastIndex = 0;
  let blockIndex = 0;
  const failures = [];

  for (const match of matches) {
    const [fullMatch, openAttrs, scriptCode] = match;
    const matchStart = match.index;

    // Append everything between the previous match and this one, untouched.
    result += html.slice(lastIndex, matchStart);

    const openTag = `<script${openAttrs}>`;
    const approxLine = html.slice(0, matchStart).split('\n').length;

    if (!scriptCode.trim()) {
      // Empty inline script block — nothing to minify, keep as-is.
      result += fullMatch;
      lastIndex = matchStart + fullMatch.length;
      blockIndex++;
      continue;
    }

    try {
      const minified = await minify(scriptCode, {
        mangle: true,
        compress: {
          unsafe: false,
          drop_console: false,
        },
        format: { comments: false },
      });
      if (minified.error) throw minified.error;
      if (typeof minified.code !== 'string') {
        throw new Error('terser produced no output code');
      }
      result += openTag + minified.code + '</script>';
    } catch (err) {
      failures.push({ blockIndex, approxLine, message: err && err.message ? err.message : String(err) });
      // Keep placeholder so we don't lose position tracking; we'll bail
      // out before writing anything anyway once failures.length > 0.
      result += fullMatch;
    }

    lastIndex = matchStart + fullMatch.length;
    blockIndex++;
  }

  result += html.slice(lastIndex);

  if (failures.length > 0) {
    console.error(`Build failed: ${failures.length} script block(s) failed to minify:`);
    for (const f of failures) {
      console.error(`  - script block #${f.blockIndex} (approx. line ${f.approxLine}): ${f.message}`);
    }
    process.exit(1);
  }

  const finalHtml = result.replace(/^<!DOCTYPE html>/i, (m) => `${m}\n${HEADER_COMMENT}`);

  fs.writeFileSync(OUT_PATH, finalHtml, 'utf8');
  fs.writeFileSync(BUILD_ID_PATH, JSON.stringify({ id: buildId, t: builtAt, version: versionMatch ? versionMatch[1] : null }) + '\n', 'utf8');
  console.log(`Build ${buildId} (${new Date(builtAt).toISOString()}) -> ${BUILD_ID_PATH}`);
  console.log(`Wrote ${OUT_PATH} (${finalHtml.length} bytes) from ${SRC_PATH} (${html.length} bytes), ${matches.length} inline script block(s) processed.`);
}

main().catch((err) => {
  console.error('Build script crashed:', err);
  process.exit(1);
});
