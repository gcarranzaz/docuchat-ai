import clsx from 'clsx';

export function ConfidenceBadge({ level }: { level: string }) {
  const colors = {
    HIGH: 'bg-green-100 text-green-800',
    MEDIUM: 'bg-yellow-100 text-yellow-800',
    LOW: 'bg-orange-100 text-orange-800',
    NONE: 'bg-red-100 text-red-800',
  };

  return (
    <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium', colors[level as keyof typeof colors])}>
      {level}
    </span>
  );
}
