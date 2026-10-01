/**
 * Authentication Context
 * ======================
 * Manages authentication state and provides auth methods to the app.
 *
 * Features:
 * - Login/Register/Logout
 * - Token refresh
 * - Persistent auth state (localStorage)
 * - Automatic token refresh on mount
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as api from '../api/client';

// ===========================================
// Types
// ===========================================

interface User {
  id: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

// ===========================================
// Context
// ===========================================

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

// ===========================================
// Provider
// ===========================================

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check if user is logged in on mount
  useEffect(() => {
    const initAuth = async () => {
      const token = localStorage.getItem('accessToken');
      if (token) {
        const response = await api.get<User>('/auth/me');
        if (response.data) {
          setUser(response.data);
        } else {
          // Token invalid or expired, clear it
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        }
      }
      setLoading(false);
    };

    initAuth();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    setLoading(true);

    try {
      const response = await api.post<any>('/auth/login', { email, password }, { skipAuth: true });

      if (response.error) {
        setError(response.error.message);
        throw new Error(response.error.message);
      }

      if (!response.data || !response.data.tokens) {
        setError('Login failed');
        throw new Error('Login failed');
      }

      // Store tokens
      localStorage.setItem('accessToken', response.data.tokens.accessToken);
      localStorage.setItem('refreshToken', response.data.tokens.refreshToken);

      // Set user
      setUser(response.data.user);
    } catch (err: any) {
      const message = err.message || 'Login failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    setError(null);
    setLoading(true);

    try {
      const response = await api.post<any>('/auth/register', { email, password }, { skipAuth: true });

      if (response.error) {
        setError(response.error.message);
        throw new Error(response.error.message);
      }

      if (!response.data || !response.data.tokens) {
        setError('Registration failed');
        throw new Error('Registration failed');
      }

      // Store tokens
      localStorage.setItem('accessToken', response.data.tokens.accessToken);
      localStorage.setItem('refreshToken', response.data.tokens.refreshToken);

      // Set user
      setUser(response.data.user);
    } catch (err: any) {
      const message = err.message || 'Registration failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    // Clear tokens
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');

    // Clear user
    setUser(null);
    setError(null);

    // Optionally call logout endpoint to invalidate refresh token
    api.post('/auth/logout', {}).catch(() => {
      // Ignore errors - user is logged out locally anyway
    });
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value: AuthContextType = {
    user,
    loading,
    error,
    login,
    register,
    logout,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
