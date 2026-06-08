#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Convert README.md to deno/index.html for serving on "/".
 * Uses marked for markdown → HTML conversion + GitHub Markdown CSS.
 */
import { marked } from "npm:marked@15";

const markdown = await Deno.readTextFile(
  new URL("../README.md", import.meta.url),
);
const htmlBody = await marked(markdown);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vela Bundler — Private Prepaid ERC-4337 Bundler</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-light.min.css">
<style>
  * { box-sizing: border-box; }
  html { background: #f6f8fa; }
  body {
    max-width: 980px;
    margin: 40px auto;
    padding: 40px 48px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .markdown-body { font-size: 16px; line-height: 1.7; margin: 40px auto !important; }
  @media (max-width: 767px) {
    body { margin: 16px; padding: 24px 16px; }
  }
</style>
</head>
<body class="markdown-body">
${htmlBody}</body>
</html>`;

const outPath = new URL("../deno/index.html", import.meta.url).pathname;
await Deno.writeTextFile(outPath, html);
console.log(`Generated ${outPath}`);
