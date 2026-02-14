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
