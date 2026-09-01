/** One stroke weight, one corner style, drawn rather than borrowed from a font. */

interface Props {
  className?: string;
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function Caret({ className, size = 12 }: Props) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function Search({ size = 14 }: Props) {
  return (
    <svg {...base(size)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L14 14" />
    </svg>
  );
}

export function ArrowRight({ size = 13 }: Props) {
  return (
    <svg {...base(size)}>
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
    </svg>
  );
}

/** The option that was taken. */
export function Check({ className, size = 14 }: Props) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.75 8.5L6.25 12l7-8" />
    </svg>
  );
}

/** An option that was not. */
export function Cross({ className, size = 14 }: Props) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** The machine decides. */
export function Monitor({ size = 15 }: Props) {
  return (
    <svg {...base(size)}>
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.25" />
      <path d="M5.75 14.25h4.5" />
    </svg>
  );
}

/** Pinned to the day ground. */
export function Sun({ size = 15 }: Props) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="8" r="3.15" />
      <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
    </svg>
  );
}

/** Pinned to the dusk ground. */
export function Moon({ size = 15 }: Props) {
  return (
    <svg {...base(size)}>
      <path d="M13.4 9.6A5.9 5.9 0 016.4 2.6a5.9 5.9 0 107 7z" />
    </svg>
  );
}

/** The work the records describe. */
export function Folder({ size = 15 }: Props) {
  return (
    <svg {...base(size)}>
      <path d="M14.67 12.67a1.33 1.33 0 01-1.34 1.33H2.67a1.33 1.33 0 01-1.34-1.33V3.33a1.33 1.33 0 011.34-1.33H6l1.33 2h6a1.33 1.33 0 011.34 1.33z" />
    </svg>
  );
}
