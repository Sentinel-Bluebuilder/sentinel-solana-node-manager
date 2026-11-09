/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: ['class', 'html[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          card: 'var(--bg-card)',
          'card-hover': 'var(--bg-card-hover)',
          input: 'var(--bg-input)',
          // Back-compat aliases for old code — all collapse to bg-card
          soft: 'var(--bg-card)',
          elev: 'var(--bg-card-hover)',
          sidebar: 'var(--bg)',
        },
        border: {
          DEFAULT: 'var(--border)',
          hover: 'var(--border-hover)',
          soft: 'var(--border)',
        },
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-dim)',
          dim: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-hover)',
          soft: 'var(--accent-glow)',
          dim: 'var(--accent-dim)',
        },
        success: 'var(--green)',
        'success-dim': 'var(--green-dim)',
        warning: 'var(--yellow)',
        'warning-dim': 'var(--yellow-dim)',
        danger: 'var(--red)',
        'danger-dim': 'var(--red-dim)',
      },
      fontFamily: {
        sans: [
          'Outfit Variable',
          'Poppins',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        display: ['Outfit Variable', 'Poppins', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Noto Sans Mono', 'JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        elev: 'var(--shadow-elev)',
      },
    },
  },
  plugins: [],
};
