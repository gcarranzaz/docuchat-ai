/**
 * Request context
 * ===============
 * Carries the request id through every async call of one request without passing it
 * as a parameter. The logger adds it to every line (utils/logger.ts) and the audit
 * trail records it (services/audit.service.ts), so one id ties together the access log,
 * application logs and audit rows of a request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
