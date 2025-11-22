import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Fuse from 'fuse.js';
import ignore from 'ignore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

// In-memory cache for file index
let fileIndex = {
  files: [],
  totalFiles: 0,
  indexed: false,
  lastIndexed: null
};

// Fuse.js configuration for fuzzy search
let fuseInstance = null;

// Patterns to skip during indexing
const skipPatterns = [
  'node_modules',
  '.git',
  '.cache',
  '__pycache__',
  '.venv',
  '.virtualenv',
  'target/debug',
  'target/release',
  '.idea',
  '.vs',
  'obj',
  'bin/debug',
  'bin/release',
  '$Recycle.Bin',
  'System Volume Information',
  'AppData/Local/Temp',
  'AppData/Local/Cache',
  'Windows/Temp',
  'ProgramData/Microsoft/Windows Defender',
  'ProgramData/NVIDIA Corporation',
  'ProgramData/Packages',
  'ProgramData/WindowsHolographicDevices',
  'Recovery',
  'Windows/System32',
  'Windows/SysWOW64'
];

// Recursively walk directory and collect files
async function walkDirectory(dirPath, fileList = [], progressCallback = null) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const normalizedPath = fullPath.replace(/\\/g, '/');
      
      // Skip patterns
      const shouldSkip = skipPatterns.some(pattern => 
        normalizedPath.toLowerCase().includes(pattern.toLowerCase())
      );
      
      if (shouldSkip) continue;
      
      if (entry.isDirectory()) {
        try {
          await walkDirectory(fullPath, fileList, progressCallback);
        } catch (err) {
          // Silently skip directories we can't access (permission errors are expected)
          if (err.code !== 'EPERM' && err.code !== 'EACCES') {
            console.warn(`Skipping ${fullPath}: ${err.message}`);
          }
        }
      } else if (entry.isFile()) {
        fileList.push(normalizedPath);
        
        // Report progress every 1000 files
        if (progressCallback && fileList.length % 1000 === 0) {
          progressCallback(fileList.length);
        }
      }
    }
  } catch (err) {
    // Silently skip permission errors
    if (err.code !== 'EPERM' && err.code !== 'EACCES') {
      console.warn(`Error reading ${dirPath}: ${err.message}`);
    }
  }
  
  return fileList;
}

// Build index endpoint
app.post('/api/build-index', async (req, res) => {
  const { rootPath, forceRebuild } = req.body;
  
  if (!rootPath) {
    return res.status(400).json({ error: 'rootPath is required' });
  }
  
  // Return cached index if available and not forcing rebuild
  if (!forceRebuild && fileIndex.indexed) {
    return res.json({
      totalFiles: fileIndex.totalFiles,
      indexed: true,
      lastIndexed: fileIndex.lastIndexed
    });
  }
  
  try {
    console.log(`Starting indexing of ${rootPath}...`);
    const startTime = Date.now();
    
    let lastProgress = 0;
    const files = await walkDirectory(rootPath, [], (count) => {
      lastProgress = count;
      console.log(`Indexed ${count.toLocaleString()} files...`);
    });
    
    fileIndex = {
      files,
      totalFiles: files.length,
      indexed: true,
      lastIndexed: new Date().toISOString()
    };
    
    // Create Fuse.js instance for fuzzy search
    fuseInstance = new Fuse(files, {
      threshold: 0.3,
      location: 0,
      distance: 100,
      minMatchCharLength: 2,
      keys: ['']
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Indexed ${files.length.toLocaleString()} files in ${duration}s`);
    
    res.json({
      totalFiles: fileIndex.totalFiles,
      indexed: true,
      lastIndexed: fileIndex.lastIndexed,
      duration
    });
  } catch (error) {
    console.error('Indexing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search endpoint
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query || query.trim() === '') {
    return res.json({ results: [], searchTime: 0 });
  }
  
  if (!fileIndex.indexed) {
    return res.status(400).json({ error: 'Index not built. Call /api/build-index first.' });
  }
  
  const startTime = Date.now();
  
  try {
    const queryLower = query.toLowerCase();
    const hasSpaces = query.includes(' ');
    
    let results = [];
    
    if (hasSpaces) {
      // Multi-part path search
      const parts = queryLower.split(/\s+/);
      
      results = fileIndex.files
        .map(filePath => {
          const pathLower = filePath.toLowerCase();
          const fileName = path.basename(filePath).toLowerCase();
          const lastPart = parts[parts.length - 1];
          
          // Check if all parts are in path
          const allPartsPresent = parts.every(part => pathLower.includes(part));
          if (!allPartsPresent) return null;
          
          let score = 300_000_000;
          
          // Exact filename match
          if (fileName === lastPart) {
            score += 200_000_000;
          } else if (fileName.includes(lastPart)) {
            score += 100_000_000;
          }
          
          // Check consecutive order
          let lastPos = 0;
          let consecutive = true;
          for (const part of parts) {
            const pos = pathLower.indexOf(part, lastPos);
            if (pos === -1) {
              consecutive = false;
              break;
            }
            lastPos = pos + part.length;
          }
          
          if (consecutive) {
            score += 50_000_000;
          }
          
          return { path: filePath, score };
        })
        .filter(item => item !== null);
    } else {
      // Single-word search with exact and fuzzy matching
      results = fileIndex.files
        .map(filePath => {
          const pathLower = filePath.toLowerCase();
          const fileName = path.basename(filePath).toLowerCase();
          const fileNameWithoutExt = fileName.split('.').slice(0, -1).join('.');
          
          let score = 0;
          
          // Exact filename match
          if (fileName === queryLower) {
            score = 1_000_000_000;
          }
          // Exact name without extension
          else if (fileNameWithoutExt === queryLower) {
            score = 900_000_000;
          }
          // Contains query
          else if (fileName.includes(queryLower)) {
            score = 500_000_000;
            if (fileName.startsWith(queryLower)) {
              score += 100_000_000;
            }
          }
          // Fuzzy match using simple scoring
          else if (fileName.includes(queryLower.charAt(0))) {
            // Simple fuzzy check
            let matchCount = 0;
            for (const char of queryLower) {
              if (fileName.includes(char)) matchCount++;
            }
            if (matchCount >= queryLower.length * 0.7) {
              score = matchCount * 10000;
            }
          }
          
          return score > 0 ? { path: filePath, score } : null;
        })
        .filter(item => item !== null);
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    // Return top 2000
    const topResults = results.slice(0, 2000).map(item => item.path);
    const searchTime = Date.now() - startTime;
    
    res.json({
      results: topResults,
      searchTime,
      totalMatches: results.length
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get index stats
app.get('/api/index-stats', (req, res) => {
  res.json({
    total_files: fileIndex.totalFiles,
    indexed: fileIndex.indexed,
    last_indexed: fileIndex.lastIndexed
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 File Finder API Server running on http://localhost:${PORT}`);
  console.log(`📁 Ready to index files!`);
});
