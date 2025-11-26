import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Simple markdown to HTML converter (basic)
function markdownToHTML(md) {
  let html = md
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    // Code blocks
    .replace(
      /```javascript\n([\s\S]*?)```/gim,
      '<pre><code class="language-javascript">$1</code></pre>'
    )
    .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/gim, '<code>$1</code>')
    // Lists
    .replace(/^\d+\.\s+(.*$)/gim, '<li>$1</li>')
    // Line breaks
    .replace(/\n\n/gim, '</p><p>')
    .replace(/\n/gim, '<br>');

  return html;
}

const mdFile = join(__dirname, '../docs/OVERDUE_EXPLAINED.md');
const htmlFile = join(__dirname, '../docs/OVERDUE_EXPLAINED.html');

try {
  const mdContent = readFileSync(mdFile, 'utf-8');
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Number Selection and Ranking Process</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      line-height: 1.6;
      color: #333;
    }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; border-bottom: 2px solid #ecf0f1; padding-bottom: 5px; }
    h3 { color: #555; margin-top: 20px; }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
    }
    pre {
      background: #f8f8f8;
      border: 1px solid #ddd;
      border-radius: 5px;
      padding: 15px;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
    }
    li { margin: 5px 0; }
    hr { border: none; border-top: 2px solid #ecf0f1; margin: 30px 0; }
    strong { color: #2c3e50; }
    @media print {
      body { max-width: 100%; }
      h1, h2 { page-break-after: avoid; }
    }
  </style>
</head>
<body>
  ${markdownToHTML(mdContent)}
</body>
</html>
  `;

  writeFileSync(htmlFile, htmlContent, 'utf-8');
  console.log('✅ HTML file created: docs/OVERDUE_EXPLAINED.html');
  console.log('📄 Open in browser and use Print → Save as PDF');
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
