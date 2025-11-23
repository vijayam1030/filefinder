/// <reference types="vite/client" />

// Extend ImportMeta for module workers
interface ImportMeta {
  url: string;
}
