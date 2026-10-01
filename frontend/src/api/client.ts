/**
 * API Client
 * ==========
 * Centralized HTTP client for backend communication.
 *
 * Features:
 * - Automatic token attachment
 * - Token refresh on 401
 * - Consistent error handling
 * - Type-safe responses
 */

import type { ApiResponse, ApiError, AuthTokens } from '../types';

// ===========================================
// Configuration
// ===========================================

// Default to backend API URL in development if not provided via Vite env.
// This avoids requests landing on the static frontend server (port 5173)
// when `VITE_API_URL` is not set (e.g., docker/nginx static serve).
const API_BASE_URL =
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '/api');

// Token storage keys
const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';

// ===========================================
// Token Management
// ===========================================

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(tokens: AuthTokens): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// ===========================================
// HTTP Client
// ===========================================

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  skipAuth?: boolean;
}

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const { body, skipAuth, ...fetchOptions } = options;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
  };

  // Attach auth token if available and not skipped
  if (!skipAuth) {
    const token = getAccessToken();
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }
  }

  const config: RequestInit = {
    ...fetchOptions,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

    // Handle 401 - attempt token refresh
    if (response.status === 401 && !skipAuth) {
      const refreshed = await attemptTokenRefresh();
      if (refreshed) {
        // Retry the original request with new token
        const newToken = getAccessToken();
        (headers as Record<string, string>)['Authorization'] = `Bearer ${newToken}`;
        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...config,
          headers,
        });
        return handleResponse<T>(retryResponse);
      }
      // Refresh failed, clear tokens
      clearTokens();
      return {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Session expired. Please login again.',
        },
      };
    }

    return handleResponse<T>(response);
  } catch (error) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network error',
      },
    };
  }
}

async function handleResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const contentType = response.headers.get('content-type');

  if (!contentType?.includes('application/json')) {
    if (!response.ok) {
      return {
        error: {
          code: 'UNKNOWN_ERROR',
          message: `Request failed with status ${response.status}`,
        },
      };
    }
    return { data: undefined as T };
  }

  const json = await response.json();

  if (!response.ok) {
    return {
      error: json.error as ApiError,
    };
  }

  return { data: json as T };
}

async function attemptTokenRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) return false;

    const data = await response.json();
    setTokens(data);
    return true;
  } catch {
    return false;
  }
}

// ===========================================
// HTTP Methods
// ===========================================

export const api = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'POST', body }),

  put: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'PUT', body }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'DELETE' }),
};

// ===========================================
// API Endpoints (to be implemented)
// ===========================================

export const authApi = {
  register: (email: string, password: string) =>
    api.post<AuthTokens>('/auth/register', { email, password }, { skipAuth: true }),

  login: (email: string, password: string) =>
    api.post<AuthTokens>('/auth/login', { email, password }, { skipAuth: true }),

  refresh: () => {
    const refreshToken = getRefreshToken();
    return api.post<AuthTokens>('/auth/refresh', { refreshToken }, { skipAuth: true });
  },

  logout: () => {
    clearTokens();
    return Promise.resolve();
  },
};

// ===========================================
// Document API
// ===========================================

export const documentApi = {
  // Upload text document
  createText: (title: string, content: string) =>
    api.post('/documents', { title, content }),

  // Upload PDF document
  uploadPdf: async (title: string, file: File) => {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('file', file);

    let token = getAccessToken();
    let response = await fetch(`${API_BASE_URL}/documents/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (response.status === 401) {
      // Intenta refresh automático
      const refreshed = await attemptTokenRefresh();
      if (refreshed) {
        token = getAccessToken();
        response = await fetch(`${API_BASE_URL}/documents/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });
      } else {
        clearTokens();
        return { error: { code: 'UNAUTHORIZED', message: 'Session expired. Please login again.' } };
      }
    }

    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch {
        error = { code: 'UNKNOWN_ERROR', message: `Request failed with status ${response.status}` };
      }
      return { error };
    }

    return { data: await response.json() };
  },

  // List documents
  list: (limit = 20, offset = 0) =>
    api.get(`/documents?limit=${limit}&offset=${offset}`),

  // Get document by ID
  getById: (id: string) => api.get(`/documents/${id}`),

  // Delete document
  delete: (id: string) => api.delete(`/documents/${id}`),
};

// ===========================================
// Chat API
// ===========================================

export const chatApi = {
  // Send a chat message
  sendMessage: (question: string, sessionId?: string, documentIds?: string[]) =>
    api.post('/chat', { question, sessionId, documentIds }),

  // List chat sessions
  listSessions: (limit = 20, offset = 0) =>
    api.get(`/chat/sessions?limit=${limit}&offset=${offset}`),

  // Get session with messages
  getSession: (sessionId: string) => api.get(`/chat/sessions/${sessionId}`),

  // Update session title
  updateSession: (sessionId: string, title: string) =>
    api.put(`/chat/sessions/${sessionId}`, { title }),

  // Delete session
  deleteSession: (sessionId: string) => api.delete(`/chat/sessions/${sessionId}`),
  // Bulk delete all sessions for user
  deleteAllSessions: () => api.delete('/chat/sessions'),
};

// ===========================================
// Extraction API
// ===========================================

export const extractionApi = {
  // Extract structured data from document
  extract: (documentId: string, schemaName: string) =>
    api.post('/extractions', { documentId, schemaName }),

  // List available schemas
  listSchemas: () => api.get('/extractions/schemas'),

  // List all extractions
  list: (limit = 20, offset = 0) =>
    api.get(`/extractions?limit=${limit}&offset=${offset}`),

  // Get extraction by ID
  getById: (id: string) => api.get(`/extractions/${id}`),

  // Get extractions for a document
  getByDocument: (documentId: string) =>
    api.get(`/extractions/document/${documentId}`),

  // Delete extraction
  delete: (id: string) => api.delete(`/extractions/${id}`),
  // Bulk delete all extractions for user
  deleteAll: () => api.delete('/extractions'),
};

// Simple exports for direct use
export const get = api.get;
export const post = api.post;
export const put = api.put;
export const del = api.delete;

export default api;
