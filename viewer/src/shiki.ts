import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import darkPlus from 'shiki/themes/dark-plus.mjs';

import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import sql from 'shiki/langs/sql.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

// Synchronous highlighter so it can run inside react-markdown's sync render.
// The JavaScript regex engine avoids the WASM/oniguruma load (which would be async).
const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [darkPlus],
  langs: [
    bash, c, cpp, csharp, css, diff, go, html, java, javascript, json, jsonc,
    kotlin, markdown, php, python, ruby, rust, sql, swift, toml, tsx,
    typescript, xml, yaml,
  ],
  engine: createJavaScriptRegexEngine(),
});

const loadedLangs = new Set(highlighter.getLoadedLanguages());

// Fence identifiers that don't match a grammar name/alias but map to one we ship.
const langAliases: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  ts: 'typescript',
  js: 'javascript',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  htm: 'html',
  md: 'markdown',
};

function resolveLang(lang: string | undefined): string {
  if (!lang) return 'text';
  const lower = lang.toLowerCase();
  const resolved = langAliases[lower] ?? lower;
  return loadedLangs.has(resolved) ? resolved : 'text';
}

/**
 * Highlight a code block to a Shiki `<pre class="shiki">…</pre>` HTML string.
 * Always dark-plus: code blocks keep a dark (VS Code) background even when the
 * app is in light theme.
 */
export function highlightToHtml(code: string, lang: string | undefined): string {
  return highlighter.codeToHtml(code, {
    lang: resolveLang(lang),
    theme: 'dark-plus',
  });
}
