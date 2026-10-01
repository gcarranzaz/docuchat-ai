/**
 * Main Application Component
 * ==========================
 * Sets up routing, authentication, and layout structure.
 *
 * Pages:
 * - /: Chat page (protected)
 * - /history: Chat history and extractions (protected)
 * - /login: Authentication
 */

import { Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { MessageSquare, History, FileText, LogOut, User } from 'lucide-react';
import clsx from 'clsx';

// Context
import { AuthProvider, useAuth } from './contexts/AuthContext';

// Pages
import ChatPage from './pages/ChatPage';
import HistoryPage from './pages/HistoryPage';
import LoginPage from './pages/LoginPage';

// Components
import ProtectedRoute from './components/ProtectedRoute';

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

function AppContent() {
  const location = useLocation();
  const { user, logout } = useAuth();

  // Don't show header/footer on login page
  const isLoginPage = location.pathname === '/login';

  if (isLoginPage) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2">
              <FileText className="w-8 h-8 text-blue-600" />
              <span className="font-bold text-xl text-gray-900">DocuChat</span>
            </Link>

            {/* Navigation */}
            <div className="flex items-center gap-4">
              <nav className="flex items-center gap-1" aria-label="Main navigation">
                <NavLink
                  to="/"
                  icon={<MessageSquare className="w-4 h-4" />}
                  active={location.pathname === '/'}
                >
                  Chat
                </NavLink>
                <NavLink
                  to="/history"
                  icon={<History className="w-4 h-4" />}
                  active={location.pathname === '/history'}
                >
                  History
                </NavLink>
              </nav>

              {/* User Menu */}
              {user && (
                <div className="flex items-center gap-3 ml-4 pl-4 border-l border-gray-200">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <User className="w-4 h-4" />
                    <span className="hidden sm:inline">{user.email}</span>
                  </div>
                  <button
                    onClick={logout}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                    title="Logout"
                  >
                    <LogOut className="w-4 h-4" />
                    <span className="hidden sm:inline">Logout</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 bg-gray-50">
        <Routes>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <ChatPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <HistoryPage />
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-4">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-gray-500">
            DocuChat
          </p>
        </div>
      </footer>
    </div>
  );
}

// ===========================================
// Navigation Link Component
// ===========================================

interface NavLinkProps {
  to: string;
  icon: React.ReactNode;
  active: boolean;
  children: React.ReactNode;
}

function NavLink({ to, icon, active, children }: NavLinkProps) {
  return (
    <Link
      to={to}
      className={clsx(
        'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

export default App;
