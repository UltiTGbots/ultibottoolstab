// src/polyfills.ts
import { Buffer } from "buffer";
import process from "process/browser";

// Make Buffer visible to every module loaded afterward
(window as any).Buffer = Buffer;
globalThis.Buffer = Buffer;

// Make process available globally
(window as any).process = process;
globalThis.process = process;
