// Web Worker for file indexing
import Fuse from 'fuse.js';

let fileIndex: string[] = [];
let fuseInstance: Fuse<string> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  switch (type) {
    case 'INDEX_FILES':
      await indexFiles(data.dirHandle, data.basePath);
      break;
    
    case 'SEARCH':
      performSearch(data.query);
      break;
    
    case 'LOAD_INDEX':
      loadIndex(data.files);
      break;
  }
};

async function indexFiles(dirHandle: any, basePath: string = '') {
  const files: string[] = [];
  const skipFolders = ['node_modules', '.git', 'target', 'dist', 'build', '__pycache__', '.cache', '.vscode'];
  
  try {
    await scanDirectory(dirHandle, basePath, files, skipFolders);
    
    fileIndex = files;
    
    // Create Fuse instance for fast searching
    fuseInstance = new Fuse(files, {
      threshold: 0.4,
      location: 0,
      distance: 100,
      minMatchCharLength: 1,
      ignoreLocation: true,
      keys: ['$']
    });
    
    self.postMessage({
      type: 'INDEX_COMPLETE',
      data: { files, totalFiles: files.length }
    });
  } catch (error: any) {
    self.postMessage({
      type: 'INDEX_ERROR',
      data: { error: error.message }
    });
  }
}

async function scanDirectory(
  dirHandle: any,
  parentPath: string,
  files: string[],
  skipFolders: string[]
): Promise<void> {
  try {
    const entries: any[] = [];
    
    // Collect all entries first
    for await (const entry of dirHandle.values()) {
      entries.push(entry);
    }
    
    // Process in chunks to avoid blocking
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      
      // Skip folders
      if (skipFolders.some(skip => fullPath.toLowerCase().includes(skip.toLowerCase()))) {
        continue;
      }
      
      if (entry.kind === 'file') {
        files.push(fullPath);
        
        // Report progress every 500 files
        if (files.length % 500 === 0) {
          self.postMessage({
            type: 'INDEX_PROGRESS',
            data: { filesIndexed: files.length }
          });
        }
      } else if (entry.kind === 'directory') {
        try {
          await scanDirectory(entry, fullPath, files, skipFolders);
        } catch (error) {
          // Skip directories we can't access
          console.warn('Skipping:', fullPath);
        }
      }
      
      // Yield to event loop every 100 entries
      if (i % 100 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  } catch (error) {
    console.warn('Error scanning directory:', parentPath);
  }
}

function loadIndex(files: string[]) {
  fileIndex = files;
  fuseInstance = new Fuse(files, {
    threshold: 0.4,
    location: 0,
    distance: 100,
    minMatchCharLength: 1,
    ignoreLocation: true,
    keys: ['$']
  });
  
  self.postMessage({
    type: 'INDEX_LOADED',
    data: { totalFiles: files.length }
  });
}

function performSearch(query: string) {
  if (!query || fileIndex.length === 0) {
    self.postMessage({
      type: 'SEARCH_COMPLETE',
      data: { results: [] }
    });
    return;
  }
  
  const startTime = performance.now();
  const queryLower = query.toLowerCase();
  const hasSpaces = query.includes(' ');
  
  let results: string[] = [];
  
  if (hasSpaces) {
    // Multi-part path search - score based on how many parts match
    const parts = queryLower.split(/\s+/);
    const pathsWithScore = fileIndex
      .map(path => {
        const pathLower = path.toLowerCase();
        const matchCount = parts.filter(part => pathLower.includes(part)).length;
        return { path, score: matchCount };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 500)
      .map(item => item.path);
    
    results = pathsWithScore;
  } else {
    // Combine exact, substring, and fuzzy matches with scoring
    const matchesWithScore: Array<{ path: string; score: number }> = [];
    
    // 1. Exact filename matches (highest score)
    for (const path of fileIndex) {
      const fileName = path.split('/').pop()?.toLowerCase() || '';
      
      if (fileName === queryLower) {
        matchesWithScore.push({ path, score: 1000 });
      } else if (fileName.includes(queryLower)) {
        // Substring match - score based on position and length ratio
        const index = fileName.indexOf(queryLower);
        const lengthRatio = queryLower.length / fileName.length;
        const score = 500 + (100 - index) + (lengthRatio * 100);
        matchesWithScore.push({ path, score });
      }
    }
    
    // 2. Always add fuzzy matches (lower scores)
    if (fuseInstance) {
      const fuzzyResults = fuseInstance.search(query, { limit: 300 });
      for (const result of fuzzyResults) {
        const path = result.item;
        // Check if not already added as exact/substring match
        if (!matchesWithScore.find(m => m.path === path)) {
          // Fuse score: 0 is perfect, 1 is worst. Invert it: lower Fuse score = higher our score
          const score = Math.max(0, 300 - (result.score || 0) * 300);
          matchesWithScore.push({ path, score });
        }
      }
    }
    
    // Sort by score (highest first) and take top 500
    matchesWithScore.sort((a, b) => b.score - a.score);
    results = matchesWithScore.slice(0, 500).map(item => item.path);
  }
  
  const searchTime = performance.now() - startTime;
  
  self.postMessage({
    type: 'SEARCH_COMPLETE',
    data: { results, searchTime }
  });
}

export {};
