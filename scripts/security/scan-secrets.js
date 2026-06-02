const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.next',
]);

const IGNORE_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
  'scan-secrets.js',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env.example',
]);

const SECRET_PATTERNS = [
  { name: 'OpenAI key', regex: /sk-[a-zA-Z0-9_-]{20,}/g },
  { name: 'Pinecone key', regex: /pcsk_[a-zA-Z0-9_-]{20,}/g },
  { name: 'Private key block', regex: /-----BEGIN PRIVATE KEY-----/g },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub token', regex: /ghp_[a-zA-Z0-9]{30,}/g },
];

function shouldScanFile(filePath) {
  const base = path.basename(filePath);
  if (IGNORE_FILES.has(base)) return false;

  if (base.endsWith('.env.example')) return true;

  const ext = path.extname(base);
  return TEXT_EXTENSIONS.has(ext);
}

function walk(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walk(fullPath, files);
      }
      continue;
    }

    if (entry.isFile() && shouldScanFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function findSecretsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, index) => {
    SECRET_PATTERNS.forEach((pattern) => {
      if (pattern.regex.test(line)) {
        findings.push({
          filePath,
          line: index + 1,
          type: pattern.name,
        });
      }
      pattern.regex.lastIndex = 0;
    });
  });

  return findings;
}

function run() {
  const files = walk(ROOT);
  const findings = files.flatMap(findSecretsInFile);

  if (findings.length === 0) {
    console.log('Security scan passed: no obvious secrets found in source files.');
    return;
  }

  console.error('Security scan failed: potential secrets detected.');
  findings.forEach((finding) => {
    const rel = path.relative(ROOT, finding.filePath).replace(/\\/g, '/');
    console.error(`- ${finding.type} at ${rel}:${finding.line}`);
  });

  process.exit(1);
}

run();
