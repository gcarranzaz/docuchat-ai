/**
 * File Upload Middleware
 * ======================
 * Configures multer for handling file uploads.
 *
 * Security considerations:
 * - File size limits
 * - MIME type allowlist
 * - Memory storage (no temp files on disk)
 * - File type validation
 */

import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../schemas/document.schema.js';

// ===========================================
// File Filter
// ===========================================

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void => {
  // Check MIME type
  if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`));
  }
};

// ===========================================
// Multer Configuration
// ===========================================

/**
 * Upload middleware for single file
 * - Stores file in memory (for processing)
 * - Limits file size
 * - Validates MIME type
 */
export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter,
}).single('file');

/**
 * Error handler for multer errors
 * Converts multer errors to user-friendly messages
 */
export function handleMulterError(error: unknown): string {
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`;
      case 'LIMIT_FILE_COUNT':
        return 'Too many files. Only one file allowed per request';
      case 'LIMIT_UNEXPECTED_FILE':
        return 'Unexpected field name. Use "file" as the field name';
      default:
        return `Upload error: ${error.message}`;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown upload error';
}
