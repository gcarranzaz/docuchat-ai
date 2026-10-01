/**
 * Prompt Builder (stage 1 of 3: prompt construction)
 * ==================================================
 * Turns trusted templates plus untrusted text into the final system/user prompts.
 * It does not call a model (stage 2: providers) and does not read the reply
 * (stage 3: postprocessing).
 *
 * Injection defence at this stage (defence in depth, not a guarantee):
 * - Every piece of untrusted text (document context, question, history, titles)
 *   goes inside delimiters that carry a per-request random nonce; the system
 *   prompt names those exact delimiters and says their content is data.
 * - Substitution is single-pass and replacement-safe (see render.ts).
 * - Prompt versions come from the registry; an unknown version throws.
 */

import { getConfig } from '../../config/index.js';
import { activePrompt, getPrompt } from './registry.js';
import { newNonce, renderTemplate, wrapUntrusted } from './render.js';

// ===========================================
// Types
// ===========================================

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  /** "name:version", stored with every answer */
  promptVersion: string;
  nonce: string;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatPromptParams {
  /** Retrieved chunks, formatted by rag/context.ts (no delimiters) */
  context: string;
  question: string;
  history?: HistoryTurn[];
}

export interface ExtractionPromptParams {
  document: string;
  schema: Record<string, unknown>;
  schemaDescription?: string;
}

export interface SummaryPromptParams {
  title: string;
  content: string;
}

export interface BuildOptions {
  /** Fixed nonce, for tests. Defaults to a fresh random one. */
  nonce?: string;
  /** Prompt version. Defaults to the one selected in configuration. */
  version?: string;
}

export interface ChatBuildOptions extends BuildOptions {
  historyTurns?: number;
  historyMaxChars?: number;
}

const SUMMARY_CONTENT_CHARS = 2000;
const SUMMARY_TITLE_CHARS = 200;

// ===========================================
// Chat (RAG)
// ===========================================

export function buildChatPrompt(params: ChatPromptParams, options: ChatBuildOptions = {}): BuiltPrompt {
  const cfg = getConfig();
  const template = options.version ? getPrompt('chat_rag', options.version) : activePrompt('chat_rag', cfg);
  const nonce = options.nonce ?? newNonce();

  const history = limitHistory(
    params.history ?? [],
    options.historyTurns ?? cfg.chatHistoryTurns,
    options.historyMaxChars ?? cfg.chatHistoryMaxChars
  );
  const historyBlock = history.length > 0 ? `${wrapUntrusted('HISTORY', nonce, history.join('\n'))}\n\n` : '';

  return {
    systemPrompt: renderTemplate(template.system, { nonce }),
    userPrompt: renderTemplate(template.user, {
      history_block: historyBlock,
      context_block: wrapUntrusted('CONTEXT', nonce, params.context),
      question_block: wrapUntrusted('QUESTION', nonce, params.question),
    }),
    promptVersion: `${template.name}:${template.version}`,
    nonce,
  };
}

/**
 * Keep the newest turns: at most `turns` entries and `maxChars` characters in
 * total. Older turns are dropped first; a single over-long newest turn is cut
 * from the front so its most recent part survives.
 */
function limitHistory(history: HistoryTurn[], turns: number, maxChars: number): string[] {
  if (turns <= 0 || maxChars <= 0) return [];

  const lines = history.slice(-turns).map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`);

  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (kept.length === 0) kept.unshift(line.slice(line.length - maxChars));
      break;
    }
    kept.unshift(line);
    used += cost;
  }
  return kept;
}

// ===========================================
// Repair (one retry when the model breaks the output format)
// ===========================================

/**
 * Same instructions plus a short note. The invalid output is NOT echoed back:
 * it may contain injected text, and the model does not need it to try again.
 */
export function buildRepairPrompt(original: BuiltPrompt, reason: string): BuiltPrompt {
  return {
    ...original,
    userPrompt: `${original.userPrompt}\n\nYour previous reply was not valid for the required format (${reason}). Reply again with ONLY the JSON object described in your instructions, with no other text.`,
  };
}

// ===========================================
// Extraction
// ===========================================

const LANGUAGE_INSTRUCTION =
  '\nRespond ONLY in English, regardless of the document language. If the document contains summaries or descriptions in another language, translate them to English in your output.';

const INVOICE_EXAMPLE = `{
  "invoiceNumber": "",
  "invoiceDate": "",
  "dueDate": "",
  "vendor": { "name": "", "address": "", "taxId": "" },
  "customer": { "name": "", "address": "", "taxId": "" },
  "items": [ { "description": "", "quantity": null, "unitPrice": null, "total": null } ],
  "subtotal": null,
  "tax": null,
  "total": null,
  "currency": ""
}`;

const RESUME_EXAMPLE = `{
  "fullName": "",
  "email": "",
  "phone": "",
  "location": "",
  "summary": "",
  "experience": [ { "title": "", "company": "", "startDate": "", "endDate": "", "description": "" } ],
  "education": [ { "degree": "", "institution": "", "graduationYear": "" } ],
  "skills": [""],
  "languages": [""]
}`;

const CONTRACT_EXAMPLE = `{
  "contractType": "",
  "effectiveDate": "",
  "expirationDate": "",
  "parties": [ { "name": "", "role": "", "address": "" } ],
  "terms": { "paymentAmount": null, "paymentSchedule": "", "deliverables": [""], "terminationClause": "" },
  "signatures": [ { "signatory": "", "date": "" } ]
}`;

function extractionTask(schemaDescription: string | undefined): string {
  const kind = schemaDescription?.toLowerCase() ?? '';
  const quality = `Quality Criteria:
- Do NOT infer or guess values.
- If the format is ambiguous, leave the field null.
- Respond ONLY with a JSON object in the exact structure below.`;

  let header: string;
  if (kind.includes('invoice')) {
    header = `Role/Context:\nYou are a business document extraction assistant specialized in invoices.\nTask:\nExtract ONLY the information that is explicitly present in the invoice document. If a field is missing, leave it as null or empty.\n${quality}\nResponse Format:\n${INVOICE_EXAMPLE}${LANGUAGE_INSTRUCTION}`;
  } else if (kind.includes('resume')) {
    header = `Role/Context:\nYou are an expert assistant for extracting structured data from resumes.\nTask:\nExtract ONLY the information that is explicitly present in the resume. If a field is missing, leave it as null or empty.\n${quality}\nResponse Format:\n${RESUME_EXAMPLE}${LANGUAGE_INSTRUCTION}`;
  } else if (kind.includes('contract')) {
    header = `Role/Context:\nYou are a legal document extraction assistant specialized in contracts.\nTask:\nExtract ONLY the information that is explicitly present in the contract document. If a field is missing, leave it as null or empty.\n${quality}\nResponse Format:\n${CONTRACT_EXAMPLE}${LANGUAGE_INSTRUCTION}`;
  } else {
    header = `Extract ONLY the information that is explicitly present in the document. Respond ONLY with a JSON object in the following structure:\n{ "field1": "", "field2": null }${LANGUAGE_INSTRUCTION}`;
  }

  const description = schemaDescription ? `\nField descriptions:\n${schemaDescription}` : '';
  return `${header}${description}`;
}

export function buildExtractionPrompt(params: ExtractionPromptParams, options: BuildOptions = {}): BuiltPrompt {
  const template = options.version ? getPrompt('extract_json', options.version) : activePrompt('extract_json', getConfig());
  const nonce = options.nonce ?? newNonce();

  return {
    systemPrompt: renderTemplate(template.system, { nonce }),
    userPrompt: renderTemplate(template.user, {
      document_block: wrapUntrusted('DOCUMENT', nonce, params.document),
      task: extractionTask(params.schemaDescription),
    }),
    promptVersion: `${template.name}:${template.version}`,
    nonce,
  };
}

// ===========================================
// Document summary
// ===========================================

export function buildSummaryPrompt(params: SummaryPromptParams, options: BuildOptions = {}): BuiltPrompt {
  const template = options.version ? getPrompt('document_summary', options.version) : activePrompt('document_summary', getConfig());
  const nonce = options.nonce ?? newNonce();

  return {
    systemPrompt: renderTemplate(template.system, { nonce }),
    userPrompt: renderTemplate(template.user, {
      title_block: wrapUntrusted('TITLE', nonce, params.title.slice(0, SUMMARY_TITLE_CHARS)),
      document_block: wrapUntrusted('DOCUMENT', nonce, params.content.slice(0, SUMMARY_CONTENT_CHARS)),
    }),
    promptVersion: `${template.name}:${template.version}`,
    nonce,
  };
}
