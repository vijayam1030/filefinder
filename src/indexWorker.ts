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
      threshold: 0.3,
      location: 0,
      distance: 100,
      minMatchCharLength: 2,
      ignoreLocation: false,
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
    threshold: 0.3,
    location: 0,
    distance: 100,
    minMatchCharLength: 2,
    ignoreLocation: false,
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
    // Multi-part path search
    const parts = queryLower.split(/\s+/);
    results = fileIndex.filter(path => {
      const pathLower = path.toLowerCase();
      return parts.every(part => pathLower.includes(part));
    }).slice(0, 2000);
  } else {
    // Exact matches first
    const exactMatches: string[] = [];
    const substringMatches: string[] = [];
    
    for (const path of fileIndex) {
      const fileName = path.split('/').pop()?.toLowerCase() || '';
      
      if (fileName === queryLower) {
        exactMatches.push(path);
      } else if (fileName.includes(queryLower)) {
        substringMatches.push(path);
      }
      
      // Limit exact+substring matches to avoid processing too many
      if (exactMatches.length + substringMatches.length >= 2000) {
        break;
      }
    }
    
    // Use fuzzy search only if we don't have enough exact matches
    if (exactMatches.length + substringMatches.length < 100 && fuseInstance) {
      const fuzzyResults = fuseInstance.search(query, { limit: 500 });
      const fuzzyMatches = fuzzyResults.map((r: any) => r.item);
      results = [...exactMatches, ...substringMatches, ...fuzzyMatches];
    } else {
      results = [...exactMatches, ...substringMatches];
    }
    
    // Remove duplicates and limit
    results = [...new Set(results)].slice(0, 2000);
  }
  
  const searchTime = performance.now() - startTime;
  
  self.postMessage({
    type: 'SEARCH_COMPLETE',
    data: { results, searchTime }
  });
}

export {};
