/**
 * Extraction Schemas
 * ==================
 * Validation and type definitions for structured data extraction.
 *
 * Features:
 * - Predefined extraction schemas (invoice, resume, contract)
 * - Custom schema validation
 * - Request/response types
 */

import { z } from 'zod';

// ===========================================
// Request Schemas
// ===========================================

export const extractionRequestSchema = z.object({
  documentId: z.string().uuid(),
  schemaName: z.string().min(1).max(100),
});

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;

// ===========================================
// Predefined Extraction Schemas
// ===========================================

/**
 * Invoice extraction schema
 */
export const invoiceSchema = {
  name: 'invoice',
  version: 'v1.0',
  description: 'Extract invoice information from documents',
  schema: z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    vendor: z.object({
      name: z.string().nullable(),
      address: z.string().nullable(),
      taxId: z.string().nullable(),
    }).nullable(),
    customer: z.object({
      name: z.string().nullable(),
      address: z.string().nullable(),
      taxId: z.string().nullable(),
    }).nullable(),
    items: z.array(z.object({
      description: z.string().nullable(),
      quantity: z.number().nullable(),
      unitPrice: z.number().nullable(),
      total: z.number().nullable(),
    })).nullable(),
    subtotal: z.number().nullable(),
    tax: z.number().nullable(),
    total: z.number().nullable(),
    currency: z.string().nullable(),
  }),
  schemaDescription: `
Field descriptions:
- invoiceNumber: The unique invoice identifier
- invoiceDate: Date when invoice was issued (YYYY-MM-DD)
- dueDate: Payment due date (YYYY-MM-DD)
- vendor: Company that issued the invoice
- customer: Company that will pay the invoice
- items: Line items with descriptions, quantities, and prices
- subtotal: Sum before taxes
- tax: Tax amount
- total: Final amount to pay
- currency: Currency code (EUR, USD, etc.)
  `.trim(),
};

/**
 * Resume/CV extraction schema
 */
export const resumeSchema = {
  name: 'resume',
  version: 'v1.0',
  description: 'Extract candidate information from resumes',
  schema: z.object({
    fullName: z.string().nullable(),
    email: z.string().email().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    summary: z.string().nullable(),
    experience: z.array(z.object({
      title: z.string().nullable(),
      company: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      description: z.string().nullable(),
    })).nullable(),
    education: z.array(z.object({
      degree: z.string().nullable(),
      institution: z.string().nullable(),
      graduationYear: z.string().nullable(),
    })).nullable(),
    skills: z.array(z.string()).nullable(),
    languages: z.array(z.string()).nullable(),
  }),
  schemaDescription: `
Field descriptions:
- fullName: Candidate's full name
- email: Contact email address
- phone: Contact phone number
- location: City/country of residence
- summary: Professional summary or objective
- experience: Work history with job titles, companies, dates, and descriptions
- education: Academic degrees with institutions and graduation years
- skills: Technical and professional skills
- languages: Spoken/written languages
  `.trim(),
};

/**
 * Contract extraction schema
 */
export const contractSchema = {
  name: 'contract',
  version: 'v1.0',
  description: 'Extract key terms from contracts',
  schema: z.object({
    contractType: z.string().nullable(),
    effectiveDate: z.string().nullable(),
    expirationDate: z.string().nullable(),
    parties: z.array(z.object({
      name: z.string().nullable(),
      role: z.string().nullable(),
      address: z.string().nullable(),
    })).nullable(),
    terms: z.object({
      paymentAmount: z.number().nullable(),
      paymentSchedule: z.string().nullable(),
      deliverables: z.array(z.string()).nullable(),
      terminationClause: z.string().nullable(),
    }).nullable(),
    signatures: z.array(z.object({
      signatory: z.string().nullable(),
      date: z.string().nullable(),
    })).nullable(),
  }),
  schemaDescription: `
Field descriptions:
- contractType: Type of contract (service, employment, NDA, etc.)
- effectiveDate: When contract becomes active (YYYY-MM-DD)
- expirationDate: When contract ends (YYYY-MM-DD)
- parties: Organizations or individuals involved
- terms: Key contract terms including payment, deliverables, termination
- signatures: Who signed and when
  `.trim(),
};

// ===========================================
// Schema Registry
// ===========================================

export const EXTRACTION_SCHEMAS = {
  invoice: invoiceSchema,
  resume: resumeSchema,
  contract: contractSchema,
} as const;

export type SchemaName = keyof typeof EXTRACTION_SCHEMAS;

/**
 * Get schema by name
 */
export function getExtractionSchema(name: string) {
  return EXTRACTION_SCHEMAS[name as SchemaName] || null;
}

/**
 * List available schemas
 */
export function listExtractionSchemas() {
  return Object.values(EXTRACTION_SCHEMAS).map((schema) => ({
    name: schema.name,
    version: schema.version,
    description: schema.description,
  }));
}

// ===========================================
// Response Schema
// ===========================================

export const extractionResponseSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  schemaName: z.string(),
  schemaVersion: z.string(),
  extractedData: z.record(z.unknown()),
  validationErrors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
  confidenceScore: z.number().nullable(),
  createdAt: z.string(),
});

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;
