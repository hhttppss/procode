/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
    './server/views/**/*.html',
    './server/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        // Тёмная база — «чернила»
        ink: {
          DEFAULT: '#0F1222',
          900: '#0B0E1B',
          800: '#0F1222',
          700: '#191D33',
          600: '#232945',
          500: '#333A5C',
        },
        // Основной бренд-цвет — кобальт
        cobalt: {
          DEFAULT: '#2B4BF2',
          700: '#1E36C9',
          600: '#2B4BF2',
          500: '#4A64F7',
          400: '#7B93FF',
          300: '#A9B8FF',
          100: '#E4E9FF',
        },
        // Тёплый акцент — абрикос
        apricot: {
          DEFAULT: '#FF9E64',
          // 700 — единственный оттенок абрикоса, пригодный для текста на светлом фоне:
          // 5.8:1 на белом и 5.1:1 на apricot-100. Более светлые дают 2.3–2.7:1 при норме 4.5:1,
          // поэтому 600 остаётся только фоном (наведение на .btn-accent).
          700: '#A8490D',
          600: '#F2803D',
          500: '#FF9E64',
          400: '#FFB98C',
          100: '#FFEDE0',
        },
        // Успех / статусы
        mint: {
          DEFAULT: '#3FBF8F',
          // 700 — для текста на светлом, по той же причине, что и apricot-700:
          // 6.0:1 на белом и 5.3:1 на mint-100 против 2.97:1 и 2.62:1 у 600-го.
          700: '#1D7052',
          600: '#2FA97B',
          500: '#3FBF8F',
          400: '#5FD8A4',
          100: '#DFF6EC',
        },
        // Светлые поверхности
        paper: '#FFFDF9',
        mist: '#EEF0F6',
        muted: '#5A6079',
      },
      fontFamily: {
        display: ['Unbounded', 'Segoe UI', 'system-ui', 'sans-serif'],
        sans: ['Onest', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 18, 34, 0.04), 0 12px 32px -12px rgba(15, 18, 34, 0.12)',
        lift: '0 2px 4px rgba(15, 18, 34, 0.06), 0 24px 48px -16px rgba(15, 18, 34, 0.22)',
        glow: '0 0 0 1px rgba(123, 147, 255, 0.18), 0 24px 60px -20px rgba(43, 75, 242, 0.55)',
      },
      maxWidth: {
        content: '75rem',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        blink: 'blink 1.1s steps(1, end) infinite',
      },
    },
  },
  plugins: [],
};
