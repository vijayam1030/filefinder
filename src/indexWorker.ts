// Web Worker for file indexing
import Fuse from 'fuse.js';
import MiniSearch from 'minisearch';

interface FileDocument {
  id: string;
  path: string;
  fileName: string;
  content?: string;
  extension: string;
}

let fileIndex: string[] = [];
let fuseInstance: Fuse<string> | null = null;
let contentIndex: MiniSearch<FileDocument> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  switch (type) {
    case 'INDEX_FILES':
      await indexFiles(data.dirHandle, data.basePath, data.indexContent);
      break;
    
    case 'SEARCH':
      performSearch(data.query, data.searchMode);
      break;
    
    case 'LOAD_INDEX':
      loadIndex(data.files);
      break;
  }
};

async function indexFiles(dirHandle: any, basePath: string = '', indexContent: boolean = false) {
  const files: string[] = [];
  const documents: FileDocument[] = [];
  const skipFolders = ['node_modules', '.git', 'target', 'dist', 'build', '__pycache__', '.cache', '.vscode'];
  
  try {
    await scanDirectory(dirHandle, basePath, files, documents, skipFolders, indexContent);
    
    fileIndex = files;
    
    // Create Fuse instance for filename searching
    fuseInstance = new Fuse(files, {
      threshold: 0.4,
      location: 0,
      distance: 100,
      minMatchCharLength: 1,
      ignoreLocation: true,
      keys: ['$']
    });
    
    // Create MiniSearch instance for full-text searching (if content was indexed)
    if (indexContent && documents.length > 0) {
      contentIndex = new MiniSearch({
        fields: ['fileName', 'content', 'path'],
        storeFields: ['path', 'fileName', 'extension'],
        searchOptions: {
          boost: { fileName: 3, path: 2, content: 1 },
          fuzzy: 0.2,
          prefix: true
        }
      });
      
      contentIndex.addAll(documents);
    }
    
    self.postMessage({
      type: 'INDEX_COMPLETE',
      data: { 
        files, 
        totalFiles: files.length,
        contentIndexed: indexContent && documents.some(d => d.content)
      }
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
  documents: FileDocument[],
  skipFolders: string[],
  indexContent: boolean
): Promise<void> {
  try {
    const entries: any[] = [];
    
    // Collect all entries first
    for await (const entry of dirHandle.values()) {
      entries.push(entry);
    }
    
    // Text file extensions to index
    const textExtensions = ['.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', 
                           '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.json', '.xml', 
                           '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.sh', '.bash', '.css', '.scss',
                           '.html', '.sql', '.r', '.m', '.lua', '.pl', '.vim', '.gradle', '.properties'];
    
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
        
        // Read content if indexContent is enabled
        let content = '';
        const extension = entry.name.includes('.') ? entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase() : '';
        
        if (indexContent && textExtensions.includes(extension)) {
          try {
            const file = await entry.getFile();
            
            // Only index files under 100KB
            if (file.size < 100 * 1024) {
              content = await file.text();
              // Truncate very long files to first 10000 characters
              if (content.length > 10000) {
                content = content.substring(0, 10000);
              }
            }
          } catch (error) {
            // Skip files we can't read
          }
        }
        
        documents.push({
          id: fullPath,
          path: fullPath,
          fileName: entry.name,
          content: content || undefined,
          extension: extension
        });
        
        // Report progress every 500 files
        if (files.length % 500 === 0) {
          self.postMessage({
            type: 'INDEX_PROGRESS',
            data: { filesIndexed: files.length }
          });
        }
      } else if (entry.kind === 'directory') {
        try {
          await scanDirectory(entry, fullPath, files, documents, skipFolders, indexContent);
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

function performSearch(query: string, searchMode: 'filename' | 'fulltext' = 'filename') {
  if (!query || fileIndex.length === 0) {
    self.postMessage({
      type: 'SEARCH_COMPLETE',
      data: { results: [] }
    });
    return;
  }
  
  const startTime = performance.now();
  
  let results: string[] = [];
  
  if (searchMode === 'fulltext' && contentIndex) {
    // Full-text search using MiniSearch
    try {
      const searchResults = contentIndex.search(query, { 
        boost: { fileName: 3, path: 2, content: 1 },
        fuzzy: 0.2,
        prefix: true
      });
      
      results = searchResults.slice(0, 500).map(result => result.path);
    } catch (error) {
      console.error('Full-text search error:', error);
      // Fallback to filename search
      results = performFilenameSearch(query);
    }
  } else {
    // Filename search (original logic)
    results = performFilenameSearch(query);
  }
  
  const searchTime = performance.now() - startTime;
  
  self.postMessage({
    type: 'SEARCH_COMPLETE',
    data: { results, searchTime }
  });
}

function performFilenameSearch(query: string): string[] {
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
  
  return results;
}

export {};
