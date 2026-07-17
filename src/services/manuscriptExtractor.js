import path from 'node:path';
import crypto from 'node:crypto';
import mammoth from 'mammoth';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import JSZip from 'jszip';
import * as cheerio from 'cheerio';

const supportedExtensions = new Set(['.docx', '.epub', '.pdf', '.txt', '.md', '.html', '.htm']);

export function manuscriptFingerprint(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function extractManuscript(buffer, fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw new Error('Supported manuscript files are DOCX, EPUB, PDF, TXT, Markdown, and HTML.');
  }

  let text = '';
  const warnings = [];
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
    warnings.push(...result.messages.map((message) => message.message).filter(Boolean));
  } else if (extension === '.pdf') {
    const result = await pdf(buffer);
    text = result.text || '';
    if (text.trim().length < 1000) warnings.push('This PDF contains very little selectable text. It may be scanned or image-based.');
  } else if (extension === '.epub') {
    text = await extractEpub(buffer);
  } else if (extension === '.html' || extension === '.htm') {
    text = htmlToText(buffer.toString('utf8'));
  } else {
    text = buffer.toString('utf8');
  }

  text = normalizeText(text);
  if (text.length < 500) throw new Error('Author HQ could not find enough readable manuscript text in that file.');
  return {
    text,
    extension,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    characterCount: text.length,
    fingerprint: manuscriptFingerprint(buffer),
    warnings
  };
}

export async function extractManuscriptCollection(files = []) {
  const readable = files
    .filter((file) => supportedExtensions.has(path.extname(String(file.originalname || '')).toLowerCase()))
    .sort((a, b) => String(a.originalname).localeCompare(String(b.originalname), undefined, { numeric: true, sensitivity: 'base' }));
  if (!readable.length) throw new Error('That folder does not contain any supported chapter files.');

  const hash = crypto.createHash('sha256');
  const sections = [];
  const warnings = [];
  let wordCount = 0;
  for (const file of readable) {
    hash.update(String(file.originalname));
    hash.update(file.buffer);
    const extracted = await extractManuscript(file.buffer, file.originalname);
    sections.push(`=== ${path.basename(file.originalname)} ===\n\n${extracted.text}`);
    wordCount += extracted.wordCount;
    warnings.push(...extracted.warnings.map((warning) => `${path.basename(file.originalname)}: ${warning}`));
  }
  const text = sections.join('\n\n');
  return {
    text,
    extension: 'chapter-folder',
    wordCount,
    characterCount: text.length,
    fingerprint: hash.digest('hex'),
    warnings,
    chapterCount: readable.length,
    chapterNames: readable.map((file) => file.originalname)
  };
}

async function extractEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  const container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = container('rootfile').attr('full-path');
  if (!opfPath) throw new Error('This EPUB does not contain a readable package document.');

  const opfXml = await readZipText(zip, opfPath);
  const opf = cheerio.load(opfXml, { xmlMode: true });
  const opfDir = path.posix.dirname(opfPath);
  const manifest = new Map();
  opf('manifest item').each((_, element) => {
    const item = opf(element);
    manifest.set(item.attr('id'), item.attr('href'));
  });
  const chapterPaths = [];
  opf('spine itemref').each((_, element) => {
    const href = manifest.get(opf(element).attr('idref'));
    if (href) chapterPaths.push(path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href))));
  });
  if (!chapterPaths.length) throw new Error('This EPUB does not contain a readable chapter spine.');

  const chapters = [];
  for (const chapterPath of chapterPaths) {
    const file = zip.file(chapterPath);
    if (!file) continue;
    chapters.push(htmlToText(await file.async('string')));
  }
  return chapters.join('\n\n');
}

async function readZipText(zip, fileName) {
  const file = zip.file(fileName);
  if (!file) throw new Error(`EPUB file is missing ${fileName}.`);
  return file.async('string');
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, svg').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, h1, h2, h3, h4, li, blockquote').each((_, element) => {
    $(element).append('\n');
  });
  return $.root().text();
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
