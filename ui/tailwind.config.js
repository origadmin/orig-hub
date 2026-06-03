/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: '0.75rem',
        '2xl': '1rem',
      },
      colors: {
        background: '#131315',
        foreground: '#e5e1e4',
        surface: {
          DEFAULT: '#131315',
          dim: '#131315',
          container: '#201f22',
          'container-low': '#1c1b1d',
          'container-lowest': '#0e0e10',
          'container-high': '#2a2a2c',
          'container-highest': '#353437',
          bright: '#39393b',
          variant: '#353437',
        },
        primary: {
          DEFAULT: '#4edea3',
          container: '#10b981',
          fixed: '#6ffbbe',
          foreground: '#003824',
        },
        secondary: {
          DEFAULT: '#4cd7f6',
          container: '#03b5d3',
          foreground: '#003640',
        },
        'on-surface': {
          DEFAULT: '#e5e1e4',
          variant: '#bbcabf',
        },
        error: '#ffb4ab',
        outline: {
          DEFAULT: '#86948a',
          variant: '#3c4a42',
        },
        card: {
          DEFAULT: '#201f22',
          foreground: '#e5e1e4',
        },
        popover: {
          DEFAULT: '#201f22',
          foreground: '#e5e1e4',
        },
        muted: {
          DEFAULT: '#201f22',
          foreground: '#bbcabf',
        },
        accent: {
          DEFAULT: '#2a2a2c',
          foreground: '#e5e1e4',
        },
        destructive: {
          DEFAULT: '#ffb4ab',
          foreground: '#690005',
        },
        border: '#3c4a42',
        input: '#3c4a42',
        ring: '#4edea3',
        chart: {
          '1': '#4edea3',
          '2': '#4cd7f6',
          '3': '#f59e0b',
          '4': '#ef4444',
          '5': '#8b5cf6',
        },
      },
      fontFamily: {
        body: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        'body-md': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '18px', fontWeight: '400' }],
        'headline-xl': ['32px', { lineHeight: '40px', fontWeight: '700', letterSpacing: '-0.02em' }],
        'headline-lg': ['24px', { lineHeight: '32px', fontWeight: '600', letterSpacing: '-0.01em' }],
        'label-caps': ['11px', { lineHeight: '16px', fontWeight: '700', letterSpacing: '0.05em' }],
        'data-mono': ['13px', { lineHeight: '16px', fontWeight: '500', letterSpacing: '0.02em' }],
      },
      spacing: {
        gutter: '16px',
        'container-padding': '12px',
        unit: '4px',
        'stack-gap': '8px',
        'margin-desktop': '24px',
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
