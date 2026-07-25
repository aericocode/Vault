/**
 * Text Extractor - Extract text content from various document formats
 * 
 * Supports: txt, md, html, json, xml, csv, log, docx, rtf
 * Extensible for future formats.
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract text from a plain text file
 */
function extractPlainText(filepath) {
  return fs.readFileSync(filepath, 'utf-8');
}

/**
 * Extract text from HTML, stripping tags
 */
function extractHtml(filepath) {
  const html = fs.readFileSync(filepath, 'utf-8');
  
  // Remove script and style tags with content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Replace block elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<br[^>]*\/?>/gi, '\n');
  
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&[a-z]+;/gi, ' '); // Other entities
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\n\s+/g, '\n').trim();
  
  return text;
}

/**
 * Extract text from JSON (pretty print keys and string values)
 */
function extractJson(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  
  try {
    const data = JSON.parse(content);
    return extractJsonText(data);
  } catch {
    // If not valid JSON, return as plain text
    return content;
  }
}

function extractJsonText(obj, depth = 0) {
  const lines = [];
  const indent = '  '.repeat(depth);
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'string') {
        lines.push(indent + item);
      } else if (typeof item === 'object' && item !== null) {
        lines.push(extractJsonText(item, depth));
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        lines.push(`${indent}${key}: ${value}`);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        lines.push(`${indent}${key}: ${value}`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${indent}${key}:`);
        lines.push(extractJsonText(value, depth + 1));
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Extract text from XML
 */
function extractXml(filepath) {
  const xml = fs.readFileSync(filepath, 'utf-8');
  
  // Remove XML declaration and processing instructions
  let text = xml.replace(/<\?[^>]+\?>/g, '');
  
  // Remove CDATA markers but keep content
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  
  // Remove XML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Remove tags but keep content
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

/**
 * Extract text from CSV (header + sample rows)
 */
function extractCsv(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length === 0) return '';
  
  const header = lines[0];
  const sampleRows = lines.slice(1, 6); // First 5 data rows
  const totalRows = lines.length - 1;
  
  let text = `CSV with ${totalRows} rows\n`;
  text += `Headers: ${header}\n`;
  text += `Sample data:\n${sampleRows.join('\n')}`;
  
  if (totalRows > 5) {
    text += `\n... and ${totalRows - 5} more rows`;
  }
  
  return text;
}

/**
 * Extract text from DOCX (requires mammoth or similar)
 * Falls back to basic XML extraction if mammoth not available
 */
async function extractDocx(filepath) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value;
  } catch (err) {
    // Fallback: try to read as zip and extract document.xml
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filepath);
      const docXml = zip.readAsText('word/document.xml');
      
      // Basic XML text extraction
      let text = docXml.replace(/<[^>]+>/g, ' ');
      text = text.replace(/\s+/g, ' ').trim();
      return text;
    } catch {
      throw new Error('Cannot extract DOCX: install mammoth (npm install mammoth) or adm-zip');
    }
  }
}

/**
 * Extract text from RTF
 */
function extractRtf(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  
  // Remove RTF control words and groups
  let text = content;
  
  // Remove header
  text = text.replace(/^\{\\rtf1[^}]*\}/m, '');
  
  // Remove control words
  text = text.replace(/\\[a-z]+\d*\s?/gi, '');
  
  // Remove braces
  text = text.replace(/[{}]/g, '');
  
  // Handle special characters
  text = text.replace(/\\'([0-9a-f]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  
  // Clean up
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

/**
 * Main extraction function - routes to appropriate extractor
 */
async function extract(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  
  const extractors = {
    // Plain text
    '.txt': extractPlainText,
    '.md': extractPlainText,
    '.markdown': extractPlainText,
    '.log': extractPlainText,
    '.ini': extractPlainText,
    '.cfg': extractPlainText,
    '.conf': extractPlainText,
    '.yaml': extractPlainText,
    '.yml': extractPlainText,
    
    // Code (treat as plain text)
    '.js': extractPlainText,
    '.ts': extractPlainText,
    '.py': extractPlainText,
    '.java': extractPlainText,
    '.c': extractPlainText,
    '.cpp': extractPlainText,
    '.h': extractPlainText,
    '.cs': extractPlainText,
    '.rb': extractPlainText,
    '.go': extractPlainText,
    '.rs': extractPlainText,
    '.php': extractPlainText,
    '.sql': extractPlainText,
    '.sh': extractPlainText,
    '.bat': extractPlainText,
    '.ps1': extractPlainText,
    
    // Markup/Data
    '.html': extractHtml,
    '.htm': extractHtml,
    '.xml': extractXml,
    '.svg': extractXml,
    '.json': extractJson,
    '.csv': extractCsv,
    '.tsv': extractCsv,
    
    // Documents
    '.docx': extractDocx,
    '.rtf': extractRtf,
  };
  
  const extractor = extractors[ext];
  
  if (!extractor) {
    // Try plain text as fallback
    try {
      return extractPlainText(filepath);
    } catch {
      throw new Error(`Unsupported document format: ${ext}`);
    }
  }
  
  const result = extractor(filepath);
  
  // Handle async extractors
  if (result instanceof Promise) {
    return await result;
  }
  
  return result;
}

/**
 * Get supported document extensions
 */
function getSupportedExtensions() {
  return [
    '.txt', '.md', '.markdown', '.log', '.ini', '.cfg', '.conf', '.yaml', '.yml',
    '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.rb', '.go', '.rs', '.php', '.sql', '.sh', '.bat', '.ps1',
    '.html', '.htm', '.xml', '.svg', '.json', '.csv', '.tsv',
    '.docx', '.rtf',
  ];
}

module.exports = {
  extract,
  getSupportedExtensions,
  extractPlainText,
  extractHtml,
  extractJson,
  extractXml,
  extractCsv,
  extractDocx,
  extractRtf,
};
