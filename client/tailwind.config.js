/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1E3A8A',
          light: '#EFF6FF',
          dark: '#1E40AF',
        },
        accent: {
          DEFAULT: '#EA6A0A',
          light: '#FFF7ED',
          dark: '#C2580A',
          decorative: '#F97316',
        },
        success: {
          DEFAULT: '#0F766E',
          light: '#CCFBF1',
          dark: '#0D5F58',
        },
        premium: {
          DEFAULT: '#7E22CE',
          light: '#F5F3FF',
        },
        amber: {
          DEFAULT: '#EF9F27',
        },
        purple: {
          DEFAULT: '#7F77DD',
        },
        red: {
          DEFAULT: '#E24B4A',
        },
        gray: {
          DEFAULT: '#888780',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      fontWeight: {
        normal: '400',
        medium: '500',
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
    },
  },
  plugins: [],
}
