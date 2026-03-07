import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#172033',
          950: '#0a1122',
        },
        // Semantic theme tokens — reference CSS custom properties from index.css
        app:            'var(--color-app)',
        surface:        'var(--color-surface)',
        'surface-alt':  'var(--color-surface-alt)',
        'surface-hover': 'var(--color-surface-hover)',
        overlay:        'var(--color-overlay)',
        primary:        'var(--color-text-primary)',
        secondary:      'var(--color-text-secondary)',
        muted:          'var(--color-text-muted)',
        faint:          'var(--color-text-faint)',
        'border-default': 'var(--color-border)',
        'border-input': 'var(--color-border-input)',
        accent:         'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        'accent-muted': 'var(--color-accent-muted)',
        success:        'var(--color-success)',
        danger:         'var(--color-danger)',
        warning:        'var(--color-warning)',
        highlight:      'var(--color-highlight)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translate(-50%, 0.5rem)' },
          '100%': { opacity: '1', transform: 'translate(-50%, 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
