const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATE_DIR
  || process.env.DATA_DIR
  || path.join(__dirname, '..', 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function dataPath(filename) {
  if (!filename) return DATA_DIR;
  if (path.isAbsolute(filename)) return filename;
  return path.join(DATA_DIR, filename);
}

function readJson(filename, fallback = null) {
  const filePath = dataPath(filename);
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filename, data) {
  ensureDataDir();
  const filePath = dataPath(filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendJsonl(filename, row) {
  ensureDataDir();
  fs.appendFileSync(dataPath(filename), `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filename) {
  const filePath = dataPath(filename);
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  DATA_DIR,
  ensureDataDir,
  dataPath,
  readJson,
  writeJson,
  appendJsonl,
  readJsonl,
};
