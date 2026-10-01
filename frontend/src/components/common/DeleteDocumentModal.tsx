import { useEffect } from 'react';
import { X, Trash2, AlertTriangle } from 'lucide-react';

export interface DeleteConfirmModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  description?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmModal({ open, title, subtitle, description, onClose, onConfirm }: DeleteConfirmModalProps) {
  // Handle ESC key to close modal
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };

    if (open) {
      document.addEventListener('keydown', handleEsc);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = 'unset';
    };
  }, [open, onClose]);

  if (!open) return null;

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fadeIn"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 relative animate-scaleIn transform transition-all">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-300 rounded-full p-1 transition-colors"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Content */}
        <div className="flex flex-col items-center text-center">
          {/* Warning icon */}
          <div className="bg-gradient-to-br from-red-100 to-red-50 rounded-full p-4 mb-4 shadow-sm">
            <AlertTriangle className="w-8 h-8 text-red-600" />
          </div>

          {/* Title */}
          <h3 id="modal-title" className="text-xl font-bold text-gray-900 mb-3">
            {title}
          </h3>

          {/* Description */}
          <div className="mb-6 space-y-2">
            {subtitle && (
              <p className="text-gray-700 text-sm leading-relaxed">
                {subtitle}
              </p>
            )}
            {description && (
              <p className="font-semibold text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                {description}
              </p>
            )}
            <p className="text-gray-600 text-sm mt-3 flex items-center justify-center gap-1">
              <Trash2 className="w-4 h-4" />
              This action cannot be undone
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 w-full">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 active:bg-gray-300 transition-all focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-2"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm bg-red-600 text-white hover:bg-red-700 active:bg-red-800 transition-all shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              autoFocus
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
